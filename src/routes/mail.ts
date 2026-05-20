import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { google } from 'googleapis';
import { requireUser } from '../auth/middleware.js';
import { tokensToClient } from '../auth/google.js';

interface ParsedMessage {
  id: string;
  thread_id: string;
  subject: string;
  sender_name: string;
  sender_email: string;
  date: string;
  snippet: string;
  is_unread: boolean;
  folders: string[];
  url: string;
}

function parseEmailAddress(from: string): { name: string; email: string } {
  const match = from.match(/^(.*?)\s*<(.+?)>$/);
  if (match) {
    return { name: match[1].trim().replace(/^"|"$/g, ''), email: match[2].trim() };
  }
  return { name: from, email: from };
}

async function pLimit<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let index = 0;

  async function worker(): Promise<void> {
    while (index < tasks.length) {
      const i = index++;
      results[i] = await tasks[i]();
    }
  }

  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(limit, tasks.length); i++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}

export async function mailRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /mail
  fastify.get('/mail', { preHandler: requireUser }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const user = request.user!;
      if (!user.google_tokens) {
        return reply.status(403).send({ error: 'Google account not connected' });
      }

      const authClient = tokensToClient(user.google_tokens, user._id);
      const gmailApi = google.gmail({ version: 'v1', auth: authClient });

      // List message IDs
      const listRes = await gmailApi.users.messages.list({
        userId: 'me',
        maxResults: 500,
        q: 'in:inbox',
      });

      const messageIds = (listRes.data.messages ?? []).map((m) => m.id!).filter(Boolean);

      if (messageIds.length === 0) {
        return reply.send({ messages: [], total: 0 });
      }

      // Fetch details with concurrency limit of 20
      const tasks = messageIds.map((id) => async (): Promise<ParsedMessage | null> => {
        try {
          const msg = await gmailApi.users.messages.get({
            userId: 'me',
            id,
            format: 'metadata',
            metadataHeaders: ['Subject', 'From', 'Date'],
          });

          const headers = msg.data.payload?.headers ?? [];
          const subject = headers.find((h) => h.name === 'Subject')?.value ?? '(Sin asunto)';
          const fromRaw = headers.find((h) => h.name === 'From')?.value ?? '';
          const date = headers.find((h) => h.name === 'Date')?.value ?? '';

          const { name: senderName, email: senderEmail } = parseEmailAddress(fromRaw);
          const labelIds = msg.data.labelIds ?? [];
          const isUnread = labelIds.includes('UNREAD');
          const folders = labelIds.filter((l) => !['UNREAD', 'CATEGORY_PERSONAL', 'CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'CATEGORY_UPDATES'].includes(l));

          return {
            id,
            thread_id: msg.data.threadId ?? '',
            subject,
            sender_name: senderName,
            sender_email: senderEmail,
            date,
            snippet: msg.data.snippet ?? '',
            is_unread: isUnread,
            folders,
            url: `https://mail.google.com/mail/u/0/#inbox/${id}`,
          };
        } catch (err) {
          console.error(`[Mail] Failed to fetch message ${id}:`, err);
          return null;
        }
      });

      const results = await pLimit(tasks, 20);
      const messages = results.filter((m): m is ParsedMessage => m !== null);

      return reply.send({ messages, total: messages.length });
    } catch (err) {
      console.error('[Mail] GET /mail error:', err);
      return reply.status(500).send({ error: 'Failed to fetch mail' });
    }
  });
}
