import { Router, Request, Response } from 'express';
import { google } from 'googleapis';
import { requireUser } from '../auth/middleware.js';
import { tokensToClient } from '../auth/google.js';

interface ParsedMessage {
  id: string; thread_id: string; subject: string;
  sender_name: string; sender_email: string; date: string;
  snippet: string; is_unread: boolean; folders: string[]; url: string;
}

function parseEmailAddress(from: string): { name: string; email: string } {
  const match = from.match(/^(.*?)\s*<(.+?)>$/);
  if (match) return { name: match[1].trim().replace(/^"|"$/g, ''), email: match[2].trim() };
  return { name: from, email: from };
}

async function pLimit<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let index = 0;
  async function worker(): Promise<void> {
    while (index < tasks.length) { const i = index++; results[i] = await tasks[i](); }
  }
  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(limit, tasks.length); i++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

const router = Router();

// GET /mail
router.get('/mail', requireUser, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    if (!user.google_tokens) { res.status(403).json({ error: 'Google account not connected' }); return; }

    const authClient = tokensToClient(user.google_tokens, user._id);
    const gmailApi = google.gmail({ version: 'v1', auth: authClient });

    const listRes = await gmailApi.users.messages.list({ userId: 'me', maxResults: 500, q: 'in:inbox' });
    const messageIds = (listRes.data.messages ?? []).map((m) => m.id!).filter(Boolean);
    if (messageIds.length === 0) { res.json({ messages: [], total: 0 }); return; }

    const tasks = messageIds.map((id) => async (): Promise<ParsedMessage | null> => {
      try {
        const msg = await gmailApi.users.messages.get({ userId: 'me', id, format: 'metadata', metadataHeaders: ['Subject', 'From', 'Date'] });
        const headers = msg.data.payload?.headers ?? [];
        const subject = headers.find((h) => h.name === 'Subject')?.value ?? '(Sin asunto)';
        const fromRaw = headers.find((h) => h.name === 'From')?.value ?? '';
        const date = headers.find((h) => h.name === 'Date')?.value ?? '';
        const { name: senderName, email: senderEmail } = parseEmailAddress(fromRaw);
        const labelIds = msg.data.labelIds ?? [];
        const isUnread = labelIds.includes('UNREAD');
        const folders = labelIds.filter((l) => !['UNREAD', 'CATEGORY_PERSONAL', 'CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'CATEGORY_UPDATES'].includes(l));
        return { id, thread_id: msg.data.threadId ?? '', subject, sender_name: senderName, sender_email: senderEmail, date, snippet: msg.data.snippet ?? '', is_unread: isUnread, folders, url: `https://mail.google.com/mail/u/0/#inbox/${id}` };
      } catch (err) {
        console.error(`[Mail] Failed to fetch message ${id}:`, err);
        return null;
      }
    });

    const results = await pLimit(tasks, 20);
    const messages = results.filter((m): m is ParsedMessage => m !== null);
    res.json({ messages, total: messages.length });
  } catch (err) {
    console.error('[Mail] GET /mail error:', err);
    res.status(500).json({ error: 'Failed to fetch mail' });
  }
});

export default router;
