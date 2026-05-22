import { ObjectId } from 'mongodb';
import OpenAI from 'openai';
import { google, drive_v3 } from 'googleapis';
import { createRequire } from 'module';

import { embeddingsCol, driveCacheCol } from '../db/client.js';
import { getConfig } from '../config.js';
import { GoogleTokens, TIER_LIMITS, PaidTier } from '../db/users.js';
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

  console.log(`[Embeddings] Full sync start for ${userId}...`);
  const allFiles = await fetchAllDriveFilesFlat(drive);
  await saveDriveCache(userId, allFiles, []).catch(() => {});

  const indexableFiles = allFiles.filter((f) => EXPORTABLE_MIMES[f.mimeType]);
  console.log(`[Embeddings] Found ${allFiles.length} files total, ${indexableFiles.length} are indexable.`);

  let processedCount = 0;
  let totalChunksInserted = 0;
  const CONCURRENCY   = 5;
  const SAVE_BATCH_SIZE = 20;

  // Use a run-specific timestamp so we can delete OLD docs at the end
  // without touching the new ones we just inserted.
  const runStartedAt = new Date();

  let currentDocs: any[] = [];
  let cappedEarly = false;

  for (let i = 0; i < indexableFiles.length; i += CONCURRENCY) {
    const batch = indexableFiles.slice(i, i + CONCURRENCY);

    await Promise.all(batch.map(async (file) => {
      try {
        let text = '';
        const exportMime = EXPORTABLE_MIMES[file.mimeType];

        if (file.mimeType.startsWith('application/vnd.google-apps.')) {
          const res = await drive.files.export({ fileId: file.id, mimeType: exportMime }, { responseType: 'text' });
          text = res.data as string;
        } else if (file.mimeType === 'application/pdf') {
          const res = await drive.files.get({ fileId: file.id, alt: 'media' }, { responseType: 'arraybuffer' });
          try {
            const _require = createRequire(import.meta.url);
            const pdfParse = _require('pdf-parse');
            const data = await pdfParse(Buffer.from(res.data as ArrayBuffer));
            text = data.text || '';
          } catch (err) {
            console.warn(`[Embeddings] PDF parse failed for "${file.name}":`, err);
          }
        } else {
          const res = await drive.files.get({ fileId: file.id, alt: 'media' }, { responseType: 'text' });
          text = res.data as string;
        }

        if (text && text.trim().length > 20) {
          const chunks = chunkText(text, 400);
          chunks.forEach((chunk, idx) => {
            currentDocs.push({
              name: file.name,
              url: file.webViewLink ?? '',
              type: file.type || 'document',
              section: `chunk_${idx}`,
              text: chunk,
            });
          });
        }
      } catch (err: any) {
        console.error(`[Embeddings] Error in ${file.name}: ${err.message}`);
      }
    }));

    processedCount += batch.length;

    // Incremental save every SAVE_BATCH_SIZE files (or on last batch)
    if (currentDocs.length > 0 && (processedCount % SAVE_BATCH_SIZE === 0 || processedCount >= indexableFiles.length)) {
      try {
        const remaining = maxEmbeddings - totalChunksInserted;
        if (remaining <= 0) {
          console.log(`[Embeddings] Drive cap reached (${maxEmbeddings}). Stopping early.`);
          currentDocs = [];
          cappedEarly = true;
          break;
        }
        const docsToInsert = currentDocs.slice(0, remaining);
        const capped = docsToInsert.length < currentDocs.length;

        console.log(`[Embeddings] Vectorizing batch: ${docsToInsert.length} chunks (Progress: ${processedCount}/${indexableFiles.length})${capped ? ' [cap reached]' : ''}`);

        const vectors = await batchEmbeddings(openai, docsToInsert.map(d => d.text));

        const embedDocs = docsToInsert.map((d, idx) => ({
          user_id:    new ObjectId(userId),
          name:       d.name,
          url:        d.url,
          type:       d.type,
          source:     'drive',
          section:    d.section,
          text:       d.text,
          preview:    d.text.length > 160 ? d.text.slice(0, 160).trimEnd() + '…' : d.text,
          embedding:  vectors[idx],
          indexed_at: new Date(), // AFTER runStartedAt → safe to keep
        }));

        if (embedDocs.length > 0) {
          await col.insertMany(embedDocs);
          totalChunksInserted += embedDocs.length;
          console.log(`[Embeddings] Inserted ${embedDocs.length} chunks. Total: ${totalChunksInserted}/${maxEmbeddings}`);
        }

        if (capped) {
          console.log(`[Embeddings] Drive embedding cap (${maxEmbeddings}) reached. Stopping.`);
          currentDocs = [];
          cappedEarly = true;
          break;
        }
      } catch (saveErr: any) {
        console.error(`[Embeddings] Critical Batch Save Error: ${saveErr.message}`);
      }

      currentDocs = [];

      broadcastJson({
        type: 'index_progress',
        userId,
        current: processedCount,
        total: indexableFiles.length,
        status: 'extracting',
      });
    }
  }

  // ── Delete OLD drive embeddings ONLY after all new ones are safely inserted ──
  // Docs inserted during this run have indexed_at >= runStartedAt.
  // Old docs have indexed_at < runStartedAt.
  if (totalChunksInserted > 0) {
    const deleted = await col.deleteMany({
      user_id: new ObjectId(userId),
      source: 'drive',
      indexed_at: { $lt: runStartedAt },
    });
    console.log(`[Embeddings] Removed ${deleted.deletedCount} stale Drive docs.`);
  }

  console.log(`[Embeddings] DRIVE SYNC COMPLETE. Total chunks: ${totalChunksInserted}`);
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

  // ── Paginate through ALL message IDs (Gmail API caps maxResults at 500/page) ──
  const messages: Array<{ id: string }> = [];
  let pageToken: string | undefined;
  const PAGE_SIZE = 500;

  console.log(`[Embeddings] Gmail: fetching up to ${maxEmails} message IDs…`);
  do {
    const res = await gmail.users.messages.list({
      userId: 'me',
      maxResults: Math.min(PAGE_SIZE, maxEmails - messages.length),
      q: '-in:spam -in:trash',
      pageToken,
    });
    const batch = (res.data.messages ?? []) as Array<{ id: string }>;
    messages.push(...batch);
    pageToken = res.data.nextPageToken ?? undefined;
    console.log(`[Embeddings] Gmail: fetched ${messages.length} IDs so far…`);
  } while (pageToken && messages.length < maxEmails);

  console.log(`[Embeddings] Gmail: ${messages.length} messages to index`);
  if (messages.length === 0) return 0;

  // ── Process in STREAMING batches: fetch → vectorize → save without accumulating all in RAM ──
  // IMPORTANT: delete old data only AFTER we successfully insert the first new batch.
  const FETCH_CONCURRENCY = 5;  // parallel Gmail API requests (conservative)
  const EMBED_BATCH       = 50; // fetch + vectorize 50 at a time — ~5 MB max in RAM

  let totalInserted = 0;
  let deletedOld    = false;

  for (let i = 0; i < messages.length; i += EMBED_BATCH) {
    const slice = messages.slice(i, i + EMBED_BATCH);
    const emailDocs: Array<{ name: string; url: string; type: string; text: string }> = [];

    // Fetch slice in parallel sub-batches
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
            name: subject,
            url:  `https://mail.google.com/mail/u/0/#inbox/${m.id}`,
            type: 'email',
            text: `De: ${from}\nFecha: ${date}\nAsunto: ${subject}\n\n${body}`,
          });
        } catch { /* skip individual failures */ }
      }));
    }

    if (emailDocs.length === 0) continue;

    // Vectorize this batch
    const vectors = await batchEmbeddings(openai, emailDocs.map((d) => d.text));
    const embedDocs = emailDocs.map((d, idx) => ({
      user_id:    new ObjectId(userId),
      name:       d.name,
      url:        d.url,
      type:       d.type,
      source:     'gmail',
      text:       d.text,
      preview:    d.text.length > 160 ? d.text.slice(0, 160).trimEnd() + '…' : d.text,
      embedding:  vectors[idx],
      indexed_at: new Date(),
    }));

    // Only delete old Gmail embeddings AFTER the first batch is ready to replace them
    if (!deletedOld) {
      await col.deleteMany({ user_id: new ObjectId(userId), source: 'gmail' });
      deletedOld = true;
    }

    await col.insertMany(embedDocs);
    totalInserted += embedDocs.length;
    console.log(`[Embeddings] Gmail: saved ${totalInserted}/${messages.length} emails…`);

    broadcastJson({
      type: 'index_progress',
      userId,
      current: totalInserted,
      total: messages.length,
      status: 'gmail',
    });
  }

  console.log(`[Embeddings] Gmail indexing complete: ${totalInserted} emails indexed.`);
  return totalInserted;
}

export async function runFullIndex(
  userId: string,
  googleTokens: GoogleTokens,
  tier: PaidTier = 'pro'
): Promise<{ drive: number; gmail: number; total: number; limits: typeof TIER_LIMITS[PaidTier] }> {
  const limits = TIER_LIMITS[tier];
  console.log(`[Embeddings] Starting full index for user ${userId} (tier: ${tier}, drive cap: ${limits.maxDriveEmbeddings}, email cap: ${limits.maxEmails})`);

  const drive = await indexDriveForUser(userId, googleTokens, limits.maxDriveEmbeddings).catch((e) => {
    console.error('[Embeddings] Drive sync FATAL error:', e);
    return 0;
  });
  const gmail = await indexGmailForUser(userId, googleTokens, limits.maxEmails).catch((e) => {
    console.error('[Embeddings] Gmail sync FATAL error:', e);
    return 0;
  });
  return { drive, gmail, total: drive + gmail, limits };
}
