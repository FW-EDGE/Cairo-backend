import { ObjectId } from 'mongodb';
import OpenAI from 'openai';
import { google, drive_v3 } from 'googleapis';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const pdf = require('pdf-parse');

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

async function batchEmbeddings(
  openai: OpenAI,
  texts: string[]
): Promise<number[][]> {
  const allVectors: number[][] = [];
  const BATCH_SIZE = 100;
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    try {
      const res = await openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: batch,
      });
      allVectors.push(...res.data.map((d) => d.embedding));
    } catch (err: any) {
      console.error(`[Embeddings] OpenAI Batch Error: ${err.message}`);
      // Return zero-vectors for this batch to avoid failing the whole process
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
  const CONCURRENCY = 5; // Even lower concurrency for better stability
  const SAVE_BATCH_SIZE = 20; // Smaller batches for more frequent updates
  
  let currentDocs: any[] = [];

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
          let parsePdf: any = (pdf as any).PDFParse || pdf;
          if (typeof parsePdf !== 'function' && (pdf as any).default) parsePdf = (pdf as any).default.PDFParse || (pdf as any).default;
          
          if (typeof parsePdf === 'function') {
            try {
              const data = await parsePdf(Buffer.from(res.data as ArrayBuffer));
              text = data.text || data.textContent || '';
            } catch {
              // Try as class
              const instance = new (parsePdf as any)(Buffer.from(res.data as ArrayBuffer));
              const data = await (instance.parse ? instance.parse() : instance);
              text = data.text || data.textContent || '';
            }
          }
        } else {
          const res = await drive.files.get({ fileId: file.id, alt: 'media' }, { responseType: 'text' });
          text = res.data as string;
        }

        if (text && text.trim().length > 20) {
          const chunks = chunkText(text, 500);
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

    // Incremental save
    if (currentDocs.length > 0 && (processedCount % SAVE_BATCH_SIZE === 0 || processedCount >= indexableFiles.length)) {
      try {
        // Enforce tier cap: trim currentDocs to not exceed remaining capacity
        const remaining = maxEmbeddings - totalChunksInserted;
        if (remaining <= 0) {
          console.log(`[Embeddings] Drive cap reached (${maxEmbeddings}). Stopping early.`);
          currentDocs = [];
          break;
        }
        const docsToInsert = currentDocs.slice(0, remaining);
        const capped = docsToInsert.length < currentDocs.length;

        console.log(`[Embeddings] Vectorizing batch: ${docsToInsert.length} chunks (Progress: ${processedCount}/${indexableFiles.length})${capped ? ' [cap reached]' : ''}`);

        const texts = docsToInsert.map(d => d.text);
        const vectors = await batchEmbeddings(openai, texts);

        const embedDocs = docsToInsert.map((d, idx) => ({
          user_id: new ObjectId(userId),
          name: d.name,
          url: d.url,
          type: d.type,
          source: 'drive',
          section: d.section,
          text: d.text,
          preview: d.text.length > 160 ? d.text.slice(0, 160).trimEnd() + '…' : d.text,
          embedding: vectors[idx],
          indexed_at: new Date(),
        }));

        if (embedDocs.length > 0) {
          // Clean old data ONLY if we have new data to replace it (on first successful batch)
          if (totalChunksInserted === 0) {
            await col.deleteMany({ user_id: new ObjectId(userId), source: 'drive' });
          }
          await col.insertMany(embedDocs);
          totalChunksInserted += embedDocs.length;
          console.log(`[Embeddings] Inserted ${embedDocs.length} chunks. Total: ${totalChunksInserted}/${maxEmbeddings}`);
        }

        if (capped) {
          console.log(`[Embeddings] Drive embedding cap (${maxEmbeddings}) reached. Stopping.`);
          currentDocs = [];
          break;
        }
      } catch (saveErr: any) {
        console.error(`[Embeddings] Critical Batch Save Error: ${saveErr.message}`);
      }
      
      currentDocs = []; // Reset for next batch
      
      broadcastJson({
        type: 'index_progress',
        userId,
        current: processedCount,
        total: indexableFiles.length,
        status: 'extracting'
      });
    }
  }

  console.log(`[Embeddings] DRIVE SYNC COMPLETE. Total chunks: ${totalChunksInserted}`);
  broadcastJson({ type: 'index_progress', userId, status: 'complete' });
  return totalChunksInserted;
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

  const listRes = await gmail.users.messages.list({ userId: 'me', maxResults: maxEmails, q: 'in:inbox' });
  const messages = listRes.data.messages ?? [];

  const emailDocs: any[] = [];
  const CONCURRENCY = 15;

  for (let i = 0; i < messages.length; i += CONCURRENCY) {
    const batch = messages.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async (m) => {
      try {
        const msg = await gmail.users.messages.get({ userId: 'me', id: m.id!, format: 'metadata', metadataHeaders: ['Subject', 'From', 'Date'] });
        const headers = msg.data.payload?.headers ?? [];
        const subject = headers.find(h => h.name === 'Subject')?.value ?? '(Sin asunto)';
        const from = headers.find(h => h.name === 'From')?.value ?? '';
        const date = headers.find(h => h.name === 'Date')?.value ?? '';
        const text = `De: ${from}\nFecha: ${date}\nAsunto: ${subject}\n${msg.data.snippet}`;
        emailDocs.push({ name: subject, url: `https://mail.google.com/mail/u/0/#inbox/${m.id}`, type: 'email', text });
      } catch (err) {}
    }));
  }

  if (emailDocs.length === 0) return 0;
  const vectors = await batchEmbeddings(openai, emailDocs.map(d => d.text));
  const embedDocs = emailDocs.map((d, i) => ({
    user_id: new ObjectId(userId),
    name: d.name,
    url: d.url,
    type: d.type,
    source: 'gmail',
    text: d.text,
    preview: d.text.length > 160 ? d.text.slice(0, 160).trimEnd() + '…' : d.text,
    embedding: vectors[i],
    indexed_at: new Date(),
  }));

  await col.deleteMany({ user_id: new ObjectId(userId), source: 'gmail' });
  await col.insertMany(embedDocs);
  console.log(`[Embeddings] Gmail indexing finished: ${embedDocs.length} chunks.`);
  return embedDocs.length;
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
