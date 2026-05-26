/**
 * Real-time Gmail actions for LLM tool calls.
 * Unlike embeddings (which are indexed snapshots), these functions hit the
 * Gmail API live so CAIRO always has access to the latest emails.
 */

import { google } from 'googleapis';
import { GoogleTokens } from '../db/users.js';
import { tokensToClient } from '../auth/google.js';
import { extractGmailBody } from './embeddingsIndexer.js';

const FETCH_CONCURRENCY = 5;

interface EmailSummary {
  id:      string;
  from:    string;
  to:      string;
  date:    string;
  subject: string;
  body:    string;
  url:     string;
}

async function fetchMessageDetail(
  gmail: ReturnType<typeof google.gmail>,
  id: string,
  bodyChars = 2_000,
): Promise<EmailSummary> {
  const msg = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
  const headers = msg.data.payload?.headers ?? [];
  const h = (name: string) => headers.find((x: any) => x.name === name)?.value ?? '';
  const body = extractGmailBody(msg.data.payload, bodyChars) || (msg.data.snippet ?? '');
  return {
    id,
    from:    h('From'),
    to:      h('To'),
    date:    h('Date'),
    subject: h('Subject') || '(Sin asunto)',
    body:    body.slice(0, bodyChars),
    url:     `https://mail.google.com/mail/u/0/#inbox/${id}`,
  };
}

function formatEmail(e: EmailSummary, index?: number): string {
  const prefix = index !== undefined ? `[${index + 1}] ` : '';
  return [
    `${prefix}📧 **${e.subject}**`,
    `De: ${e.from}`,
    `Para: ${e.to}`,
    `Fecha: ${e.date}`,
    `URL: ${e.url}`,
    ``,
    e.body,
  ].join('\n');
}

/**
 * Search Gmail with any query string (same syntax as Gmail search bar).
 * Returns a formatted summary of up to maxResults emails.
 */
export async function searchGmail(
  userId:     string,
  tokens:     GoogleTokens,
  query:      string,
  maxResults: number = 10,
): Promise<string> {
  const auth  = tokensToClient(tokens, userId);
  const gmail = google.gmail({ version: 'v1', auth });
  const limit = Math.min(Math.max(maxResults, 1), 20);

  const listRes = await gmail.users.messages.list({
    userId:     'me',
    q:          query,
    maxResults: limit,
  });

  const messages = listRes.data.messages ?? [];
  if (messages.length === 0) {
    return `No se encontraron emails con la búsqueda: "${query}"`;
  }

  // Fetch details concurrently in small batches
  const results: EmailSummary[] = [];
  for (let i = 0; i < messages.length; i += FETCH_CONCURRENCY) {
    const batch = messages.slice(i, i + FETCH_CONCURRENCY);
    const details = await Promise.allSettled(
      batch.map(m => fetchMessageDetail(gmail, m.id!))
    );
    for (const r of details) {
      if (r.status === 'fulfilled') results.push(r.value);
    }
  }

  const lines = results.map((e, i) => formatEmail(e, i));
  return `Encontré ${results.length} email(s) para "${query}":\n\n${lines.join('\n\n---\n\n')}`;
}

/**
 * Read the full content of a single email by its Gmail message ID.
 */
export async function readEmail(
  userId:    string,
  tokens:    GoogleTokens,
  messageId: string,
): Promise<string> {
  const auth  = tokensToClient(tokens, userId);
  const gmail = google.gmail({ version: 'v1', auth });

  try {
    const e = await fetchMessageDetail(gmail, messageId, 5_000);
    return formatEmail(e);
  } catch (err: any) {
    return `Error al leer el email ${messageId}: ${err.message}`;
  }
}
