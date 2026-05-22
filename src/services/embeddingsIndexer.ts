import { ObjectId } from 'mongodb';
import OpenAI from 'openai';
import { google, drive_v3 } from 'googleapis';
import { createRequire } from 'module';

import { embeddingsCol, driveCacheCol } from '../db/client.js';
import { getConfig } from '../config.js';
import { GoogleTokens, TIER_LIMITS, Tier } from '../db/users.js';
import { tokensToClient } from '../auth/google.js';
import { DriveFile, saveDriveCache } from '../db/driveCache.js';
import { mimeToType } from '../routes/drive.js';
import { broadcastJson } from '../websocket.js';

const EXPORTABLE_MIMES: Record<string, string> = {
  'application/vnd.google-apps.document': 'text/plain',
  'application/vnd.google-apps.spreadsheet': 'text/csv',
  'application/vnd.google-apps.presentation': 'text/plain',
  'application/pdf': 'application/pdf',
  'text/plain': 'text/plain',
  'text/markdown': 'text/plain',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

function chunkText(text: string, chunkSize = 400): string[] {
  // Clean text from null bytes or weird control chars that break Mongo/OpenAI
  const clean = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFD]/g, '');
  const words = clean.split(/\s+/);
  const chunks: string[] = [];
  for (let i = 0; i < words.length; i += chunkSize) {
    chunks.push(words.slice(i, i + chunkSize).join(' '));
  }
  return chunks.filter((c) => c.trim().length > 20); // Only chunks with meaningful length
}

/**
 * Read a Node.js Readable stream collecting at most `maxBytes` bytes, then
 * destroy the stream so the HTTP connection closes early.
 * Never loads more than maxBytes into RAM regardless of remote file size.
 */
async function streamToText(stream: NodeJS.ReadableStream, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const raw of stream as AsyncIterable<Buffer | string>) {
    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as string);
    const space = maxBytes - total;
    if (buf.length >= space) {
      chunks.push(buf.subarray(0, space));
      (stream as any).destroy?.();
      total += space;
      break;
    }
    chunks.push(buf);
    total += buf.length;
  }
  return Buffer.concat(chunks).toString('utf8');
}

// text-embedding-3-small: max 8,191 tokens per input, 300,000 tokens per batch request.
// At ~4 chars/token, 6,000 chars ≈ 1,500 tokens — safe per-input ceiling.
// With BATCH_SIZE=50: 50 × 1,500 = 75,000 tokens max per request — well under the 300k limit.
const MAX_CHARS_PER_TEXT = 6_000;
const EMBED_BATCH_SIZE   = 50;

function truncateForEmbedding(text: string): string {
  return text.length > MAX_CHARS_PER_TEXT ? text.slice(0, MAX_CHARS_PER_TEXT) : text;
}

async function batchEmbeddings(
  openai: OpenAI,
  texts: string[]
): Promise<number[][]> {
  const allVectors: number[][] = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
    const batch = texts.slice(i, i + EMBED_BATCH_SIZE).map(truncateForEmbedding);
    try {
      const res = await openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: batch,
      });
      allVectors.push(...res.data.map((d) => d.embedding));
    } catch (err: any) {
      console.error(`[Embeddings] OpenAI Batch Error: ${err.message}`);
      // Return zero-vectors for this batch so the rest of indexing continues
      allVectors.push(...batch.map(() => new Array(1536).fill(0)));
    }
  }
  return allVectors;
}

async function fetchAllDriveFilesFlat(driveApi: drive_v3.Drive): Promise<DriveFile[]> {
  const files: DriveFile[] = [];
  const fields = 'nextPageToken, files(id, name, mimeType, modifiedTime, webViewLink, parents, size, shared)';
  let pageToken: string | undefined;
  do {
    const res = await driveApi.files.list({
      q: "trashed=false",
      fields,
      pageSize: 100, // Reduced page size for stability
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      // Removed corpora: 'allDrives' to support personal accounts
    });
    const batch = res.data.files ?? [];
    for (const f of batch) {
      files.push({
        id: f.id ?? '',
        name: f.name ?? '',
        mimeType: f.mimeType ?? '',
        type: mimeToType(f.mimeType ?? ''),
        modifiedTime: f.modifiedTime ?? undefined,
        webViewLink: f.webViewLink ?? undefined,
        parents: f.parents ?? [],
        size: f.size ?? undefined,
        shared: f.shared ?? false,
      });
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  return files;
}

export async function indexDriveForUser(
  userId: string,
  googleTokens: GoogleTokens,
  maxEmbeddings: number = TIER_LIMITS.business.maxDriveEmbeddings
): Promise<number> {
  const config = getConfig();
  const openai = new OpenAI({ apiKey: config.llm.openai.api_key });
  const authClient = tokensToClient(googleTokens, userId);
  const drive = google.drive({ version: 'v3', auth: authClient });
  const col = await embeddingsCol();
  const uid = new ObjectId(userId);

  const allFiles = await fetchAllDriveFilesFlat(drive);
  await saveDriveCache(userId, allFiles, []).catch(() => {});

  const indexableFiles = allFiles.filter((f) => EXPORTABLE_MIMES[f.mimeType]);
  console.log(`[Embeddings] Drive: ${indexableFiles.length} indexable files found.`);

  // ── Load already-indexed file IDs → their latest indexed_at ──────────────
  const existingRaw = await col
    .find({ user_id: uid, source: 'drive' })
    .project({ file_id: 1, url: 1, indexed_at: 1 })
    .toArray();

  // Map: file_id → most recent indexed_at for that file
  // Old docs may not have file_id — extract it from the Google Drive URL as fallback.
  // Drive URLs look like: https://docs.google.com/document/d/FILE_ID/edit
  //                   or: https://drive.google.com/file/d/FILE_ID/view
  function fileIdFromUrl(url: string): string {
    const m = url.match(/\/d\/([a-zA-Z0-9_-]{10,})/);
    return m ? m[1] : '';
  }

  const indexedMap = new Map<string, Date>();
  for (const doc of existingRaw) {
    const fid = doc.file_id ? String(doc.file_id) : fileIdFromUrl(String(doc.url ?? ''));
    if (!fid) continue;
    const prev = indexedMap.get(fid);
    const cur  = doc.indexed_at instanceof Date ? doc.indexed_at : new Date(doc.indexed_at);
    if (!prev || cur > prev) indexedMap.set(fid, cur);
  }

  // ── Filter: only files that are new or modified since last index ──────────
  const toIndex = indexableFiles.filter((file) => {
    const lastIndexed = indexedMap.get(file.id);
    if (!lastIndexed) return true; // never indexed
    if (!file.modifiedTime) return false;
    return new Date(file.modifiedTime) > lastIndexed; // modified since last index
  });

  const alreadyIndexed = indexableFiles.length - toIndex.length;
  console.log(`[Embeddings] Drive: ${alreadyIndexed} up-to-date, ${toIndex.length} to index.`);
  if (toIndex.length === 0) {
    broadcastJson({ type: 'index_progress', userId, status: 'complete' });
    return 0;
  }

  const MAX_FILE_CHARS  = 20_000;
  const MAX_FILE_BYTES  = 10_000_000;
  const MAX_STREAM_BYTES = MAX_FILE_CHARS * 4;
  const SAVE_BATCH_SIZE = 5;

  let currentDocs: any[] = [];
  let processedCount    = 0;
  let totalChunksInserted = 0;

  // Keep track of which file IDs we're re-indexing so we can delete their old chunks
  const reindexedFileIds: string[] = [];

  for (let i = 0; i < toIndex.length; i++) {
    const file = toIndex[i];
    try {
      const fileBytes = file.size ? parseInt(file.size, 10) : 0;
      if (fileBytes > MAX_FILE_BYTES) {
        console.log(`[Embeddings] Skipping "${file.name}" (${Math.round(fileBytes / 1_000_000)}MB > limit)`);
        processedCount++;
        continue;
      }

      let text = '';
      const exportMime = EXPORTABLE_MIMES[file.mimeType];

      if (file.mimeType.startsWith('application/vnd.google-apps.')) {
        const res = await drive.files.export(
          { fileId: file.id, mimeType: exportMime },
          { responseType: 'stream' }
        );
        text = await streamToText(res.data as unknown as NodeJS.ReadableStream, MAX_STREAM_BYTES);
      } else if (file.mimeType === 'application/pdf') {
        const MAX_PDF_BYTES = 3_000_000;
        const pdfBytes = file.size ? parseInt(file.size, 10) : 0;
        if (pdfBytes > MAX_PDF_BYTES) {
          console.log(`[Embeddings] Skipping PDF "${file.name}" (${Math.round(pdfBytes / 1_000_000)}MB > 3MB limit)`);
        } else {
          try {
            const res = await drive.files.get(
              { fileId: file.id, alt: 'media' },
              { responseType: 'arraybuffer' }
            );
            const _require = createRequire(import.meta.url);
            const pdfParse = _require('pdf-parse');
            const data = await pdfParse(Buffer.from(res.data as ArrayBuffer));
            text = (data.text || '').slice(0, MAX_FILE_CHARS);
          } catch (err) {
            console.warn(`[Embeddings] PDF parse failed for "${file.name}":`, err);
          }
        }
      } else {
        const res = await drive.files.get(
          { fileId: file.id, alt: 'media' },
          { responseType: 'stream' }
        );
        text = await streamToText(res.data as unknown as NodeJS.ReadableStream, MAX_STREAM_BYTES);
      }

      if (text && text.trim().length > 20) {
        const chunks = chunkText(text, 400);
        chunks.forEach((chunk, idx) => {
          currentDocs.push({
            file_id: file.id,
            name:    file.name,
            url:     file.webViewLink ?? '',
            type:    file.type || 'document',
            section: `chunk_${idx}`,
            text:    chunk,
          });
        });
        reindexedFileIds.push(file.id);
      }
    } catch (err: any) {
      console.error(`[Embeddings] Error in "${file.name}": ${err.message}`);
    }

    processedCount++;

    // Save every SAVE_BATCH_SIZE files or on the last one
    if (currentDocs.length > 0 && (processedCount % SAVE_BATCH_SIZE === 0 || processedCount >= toIndex.length)) {
      try {
        const remaining = maxEmbeddings - totalChunksInserted;
        if (remaining <= 0) {
          console.log(`[Embeddings] Drive cap reached (${maxEmbeddings}).`);
          currentDocs = [];
          break;
        }
        const docsToInsert = currentDocs.slice(0, remaining);
        const capped = docsToInsert.length < currentDocs.length;

        const vectors = await batchEmbeddings(openai, docsToInsert.map(d => d.text));
        const now = new Date();
        const embedDocs = docsToInsert.map((d, idx) => ({
          user_id:    uid,
          file_id:    d.file_id,
          name:       d.name,
          url:        d.url,
          type:       d.type,
          source:     'drive',
          section:    d.section,
          text:       d.text,
          preview:    d.text.length > 160 ? d.text.slice(0, 160).trimEnd() + '…' : d.text,
          embedding:  vectors[idx],
          indexed_at: now,
        }));

        // Delete OLD chunks only for the specific files being re-indexed
        const fileIdsInBatch = [...new Set(docsToInsert.map(d => d.file_id))];
        if (fileIdsInBatch.length > 0) {
          await col.deleteMany({
            user_id: uid,
            source:  'drive',
            file_id: { $in: fileIdsInBatch },
            indexed_at: { $lt: now },
          });
        }

        await col.insertMany(embedDocs);
        totalChunksInserted += embedDocs.length;
        console.log(`[Embeddings] Drive: +${embedDocs.length} chunks (${processedCount}/${toIndex.length} files)`);

        if (capped) { currentDocs = []; break; }
      } catch (saveErr: any) {
        console.error(`[Embeddings] Batch save error: ${saveErr.message}`);
      }

      currentDocs = [];
      broadcastJson({ type: 'index_progress', userId, current: processedCount, total: toIndex.length, status: 'drive' });
    }
  }

  console.log(`[Embeddings] Drive sync complete. New chunks: ${totalChunksInserted}`);
  broadcastJson({ type: 'index_progress', userId, status: 'complete' });
  return totalChunksInserted;
}

/** Extract plain text from a Gmail message part tree (recursive). */
function extractGmailBody(payload: any, maxChars = 2000): string {
  if (!payload) return '';
  // If this part has a body with data, decode it
  if (payload.body?.data) {
    try {
      const decoded = Buffer.from(payload.body.data, 'base64').toString('utf-8');
      // Strip HTML tags for plain text
      const plain = decoded.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      if (plain.length > 20) return plain.slice(0, maxChars);
    } catch { /* ignore */ }
  }
  // Recurse into parts
  if (Array.isArray(payload.parts)) {
    // Prefer text/plain over text/html
    const plainPart = payload.parts.find((p: any) => p.mimeType === 'text/plain');
    const htmlPart  = payload.parts.find((p: any) => p.mimeType === 'text/html');
    for (const part of [plainPart, htmlPart, ...payload.parts]) {
      if (!part) continue;
      const text = extractGmailBody(part, maxChars);
      if (text.length > 20) return text;
    }
  }
  return '';
}

export async function indexGmailForUser(
  userId: string,
  googleTokens: GoogleTokens,
  maxEmails: number = TIER_LIMITS.business.maxEmails
): Promise<number> {
  const config = getConfig();
  const openai = new OpenAI({ apiKey: config.llm.openai.api_key });
  const authClient = tokensToClient(googleTokens, userId);
  const gmail = google.gmail({ version: 'v1', auth: authClient });
  const col = await embeddingsCol();
  const uid = new ObjectId(userId);

  // ── Load already-indexed message IDs ─────────────────────────────────────
  const existingRaw = await col
    .find({ user_id: uid, source: 'gmail' })
    .project({ message_id: 1, url: 1 })
    .toArray();
  const indexedMsgIds = new Set<string>(
    existingRaw.map(d => {
      // New docs have message_id directly; old docs only have it embedded in the URL
      // URL format: https://mail.google.com/mail/u/0/#inbox/MESSAGE_ID
      if (d.message_id) return String(d.message_id);
      const url = String(d.url ?? '');
      return url.split('/').pop() ?? '';
    }).filter(Boolean)
  );
  console.log(`[Embeddings] Gmail: ${indexedMsgIds.size} messages already indexed.`);

  // ── Paginate message IDs, stop once we have enough NEW ones ──────────────
  const newMessages: Array<{ id: string }> = [];
  let pageToken: string | undefined;
  const PAGE_SIZE = 500;

  do {
    const res = await gmail.users.messages.list({
      userId: 'me',
      maxResults: PAGE_SIZE,
      q: '-in:spam -in:trash',
      pageToken,
    });
    const batch = (res.data.messages ?? []) as Array<{ id: string }>;
    for (const m of batch) {
      if (!indexedMsgIds.has(m.id!)) newMessages.push(m);
      if (newMessages.length >= maxEmails) break;
    }
    pageToken = res.data.nextPageToken ?? undefined;
    console.log(`[Embeddings] Gmail: ${newMessages.length} new IDs found so far…`);
  } while (pageToken && newMessages.length < maxEmails);

  console.log(`[Embeddings] Gmail: ${newMessages.length} new messages to index.`);
  if (newMessages.length === 0) {
    broadcastJson({ type: 'index_progress', userId, status: 'complete' });
    return 0;
  }

  // ── Process in streaming batches: fetch → vectorize → insert (never delete) ──
  const FETCH_CONCURRENCY = 5;
  const EMBED_BATCH       = 50;
  let totalInserted = 0;

  for (let i = 0; i < newMessages.length; i += EMBED_BATCH) {
    const slice = newMessages.slice(i, i + EMBED_BATCH);
    const emailDocs: Array<{ message_id: string; name: string; url: string; text: string }> = [];

    for (let j = 0; j < slice.length; j += FETCH_CONCURRENCY) {
      const subBatch = slice.slice(j, j + FETCH_CONCURRENCY);
      await Promise.all(subBatch.map(async (m) => {
        try {
          const msg = await gmail.users.messages.get({
            userId: 'me',
            id: m.id!,
            format: 'full',
          });
          const headers = msg.data.payload?.headers ?? [];
          const subject = headers.find((h: any) => h.name === 'Subject')?.value ?? '(Sin asunto)';
          const from    = headers.find((h: any) => h.name === 'From')?.value ?? '';
          const date    = headers.find((h: any) => h.name === 'Date')?.value ?? '';
          const body    = extractGmailBody(msg.data.payload) || (msg.data.snippet ?? '');
          emailDocs.push({
            message_id: m.id!,
            name: subject,
            url:  `https://mail.google.com/mail/u/0/#inbox/${m.id}`,
            text: `De: ${from}\nFecha: ${date}\nAsunto: ${subject}\n\n${body}`,
          });
        } catch { /* skip individual failures */ }
      }));
    }

    if (emailDocs.length === 0) continue;

    const vectors = await batchEmbeddings(openai, emailDocs.map((d) => d.text));
    const embedDocs = emailDocs.map((d, idx) => ({
      user_id:    uid,
      message_id: d.message_id,
      name:       d.name,
      url:        d.url,
      type:       'email',
      source:     'gmail',
      text:       d.text,
      preview:    d.text.length > 160 ? d.text.slice(0, 160).trimEnd() + '…' : d.text,
      embedding:  vectors[idx],
      indexed_at: new Date(),
    }));

    // Pure insert — never delete existing emails
    await col.insertMany(embedDocs);
    totalInserted += embedDocs.length;
    console.log(`[Embeddings] Gmail: +${embedDocs.length} (${totalInserted}/${newMessages.length} new)`);

    broadcastJson({ type: 'index_progress', userId, current: totalInserted, total: newMessages.length, status: 'gmail' });
  }

  console.log(`[Embeddings] Gmail complete: ${totalInserted} new emails indexed.`);
  return totalInserted;
}

export async function runFullIndex(
  userId: string,
  googleTokens: GoogleTokens,
  tier: Tier = 'free'
): Promise<{ drive: number; gmail: number; total: number; limits: typeof TIER_LIMITS[Tier] }> {
  const limits = TIER_LIMITS[tier];
  console.log(`[Embeddings] Starting full index for user ${userId} (tier: ${tier}, drive cap: ${limits.maxDriveEmbeddings}, email cap: ${limits.maxEmails})`);

  // Gmail first — lighter, must complete before Drive potentially crashes.
  const gmail = await indexGmailForUser(userId, googleTokens, limits.maxEmails).catch((e) => {
    console.error('[Embeddings] Gmail sync FATAL error:', e);
    return 0;
  });

  // Skip Drive entirely for free tier (cap = 0).
  const drive = limits.maxDriveEmbeddings === 0 ? 0 : await indexDriveForUser(userId, googleTokens, limits.maxDriveEmbeddings).catch((e) => {
    console.error('[Embeddings] Drive sync FATAL error:', e);
    return 0;
  });

  return { drive, gmail, total: drive + gmail, limits };
}
