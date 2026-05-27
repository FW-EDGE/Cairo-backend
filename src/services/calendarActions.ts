/**
 * Real-time Google Calendar & Contacts actions for LLM tool calls.
 * Requires scopes: calendar.events, contacts.readonly
 */

import { google } from 'googleapis';
import { GoogleTokens } from '../db/users.js';
import { tokensToClient } from '../auth/google.js';

const TZ_DEFAULT = 'America/Argentina/Buenos_Aires';

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatEvent(e: any, index?: number): string {
  const prefix   = index !== undefined ? `[${index + 1}] ` : '';
  const start    = e.start?.dateTime || e.start?.date || '?';
  const end      = e.end?.dateTime   || e.end?.date   || '?';
  const who      = (e.attendees ?? []).map((a: any) => `${a.displayName || a.email} <${a.email}>`).join(', ') || 'Sin invitados';
  const location = e.location ? `\nLugar: ${e.location}` : '';
  const desc     = e.description ? `\nDescripción: ${e.description.slice(0, 200)}` : '';
  return [
    `${prefix}📅 **${e.summary || '(Sin título)'}**`,
    `Inicio: ${start}`,
    `Fin:    ${end}`,
    `Invitados: ${who}${location}${desc}`,
    `ID: ${e.id}`,
    `Link: ${e.htmlLink ?? ''}`,
  ].join('\n');
}

/** Add 1 hour to an ISO datetime string */
function plusOneHour(iso: string): string {
  const d = new Date(iso);
  d.setHours(d.getHours() + 1);
  return d.toISOString();
}

// ── listCalendarEvents ────────────────────────────────────────────────────────

export async function listCalendarEvents(
  userId:     string,
  tokens:     GoogleTokens,
  maxResults: number  = 10,
  timeMin?:   string,
  timeMax?:   string,
): Promise<string> {
  const auth     = tokensToClient(tokens, userId);
  const calendar = google.calendar({ version: 'v3', auth });

  const params: any = {
    calendarId:  'primary',
    maxResults:  Math.min(Math.max(maxResults, 1), 25),
    singleEvents: true,
    orderBy:     'startTime',
    timeMin:     timeMin || new Date().toISOString(),
  };
  if (timeMax) params.timeMax = timeMax;

  const res    = await calendar.events.list(params);
  const events = res.data.items ?? [];

  if (events.length === 0) return 'No hay eventos en el rango indicado.';

  const lines = events.map((e, i) => formatEvent(e, i));
  return `${events.length} evento(s) encontrado(s):\n\n${lines.join('\n\n---\n\n')}`;
}

// ── createCalendarEvent ───────────────────────────────────────────────────────

export interface CalendarEventParams {
  summary:      string;
  description?: string;
  location?:    string;
  start:        string;   // ISO 8601  e.g. "2026-05-29T16:00:00"
  end?:         string;   // optional; defaults to start + 1 hour
  timezone?:    string;   // defaults to TZ_DEFAULT
  attendees?:   string[]; // email addresses
}

export async function createCalendarEvent(
  userId:  string,
  tokens:  GoogleTokens,
  params:  CalendarEventParams,
): Promise<string> {
  const auth     = tokensToClient(tokens, userId);
  const calendar = google.calendar({ version: 'v3', auth });

  const tz  = params.timezone || TZ_DEFAULT;
  const end = params.end || plusOneHour(params.start);

  const body: any = {
    summary:     params.summary,
    description: params.description,
    location:    params.location,
    start:       { dateTime: params.start, timeZone: tz },
    end:         { dateTime: end,          timeZone: tz },
  };

  if (params.attendees && params.attendees.length > 0) {
    body.attendees = params.attendees.map(email => ({ email: email.trim() }));
  }

  const res     = await calendar.events.insert({
    calendarId:  'primary',
    requestBody: body,
    sendUpdates: 'all', // sends calendar invites to all attendees
  });

  const ev = res.data;
  return [
    `✅ Evento creado exitosamente.`,
    `Título:    ${ev.summary}`,
    `Inicio:    ${ev.start?.dateTime}`,
    `Fin:       ${ev.end?.dateTime}`,
    `Invitados: ${(params.attendees ?? []).join(', ') || 'Ninguno'}`,
    `Link:      ${ev.htmlLink}`,
  ].join('\n');
}

// ── searchContacts ────────────────────────────────────────────────────────────

/**
 * Finds email addresses for a person by name.
 * Strategy 1: Google People API (contacts.readonly scope).
 * Strategy 2: Fallback — scan Gmail headers for matching addresses.
 */
export async function searchContacts(
  userId: string,
  tokens: GoogleTokens,
  query:  string,
): Promise<string> {
  const auth = tokensToClient(tokens, userId);

  // ── Strategy 1: People API ────────────────────────────────────────────────
  try {
    const people  = google.people({ version: 'v1', auth });
    const res     = await people.people.searchContacts({
      query,
      readMask: 'names,emailAddresses',
      pageSize: 10,
    });
    const results = res.data.results ?? [];
    if (results.length > 0) {
      const lines = results.map((r: any) => {
        const name   = r.person?.names?.[0]?.displayName ?? '?';
        const emails = (r.person?.emailAddresses ?? []).map((e: any) => e.value).join(', ');
        return `${name}: ${emails}`;
      });
      return `Contactos encontrados para "${query}":\n${lines.join('\n')}`;
    }
  } catch {
    // Scope not granted or API error — fall through to Gmail strategy
  }

  // ── Strategy 2: Gmail header scan ─────────────────────────────────────────
  try {
    const gmail   = google.gmail({ version: 'v1', auth });
    const listRes = await gmail.users.messages.list({
      userId:     'me',
      q:          query,
      maxResults: 10,
    });
    const messages = listRes.data.messages ?? [];
    if (messages.length === 0) {
      return `No encontré contactos ni emails para "${query}".`;
    }

    const emailSet = new Set<string>();
    const nameMap:  Record<string, string> = {};

    for (const msg of messages.slice(0, 8)) {
      const detail = await gmail.users.messages.get({
        userId:          'me',
        id:              msg.id!,
        format:          'metadata',
        metadataHeaders: ['From', 'To', 'Cc'],
      });
      const headers = detail.data.payload?.headers ?? [];
      for (const h of headers) {
        if (!['From', 'To', 'Cc'].includes(h.name ?? '')) continue;
        const val = h.value ?? '';
        // Match: "Display Name <email@example.com>" or bare email
        const pairs = [...val.matchAll(/([^<,]+?)\s*<([\w.+\-]+@[\w.-]+\.[a-zA-Z]{2,})>/g)];
        for (const [, name, email] of pairs) {
          emailSet.add(email);
          nameMap[email] = name.trim().replace(/^"|"$/g, '');
        }
        // Also pick up bare emails
        const bare = val.match(/[\w.+\-]+@[\w.-]+\.[a-zA-Z]{2,}/g) ?? [];
        bare.forEach(e => emailSet.add(e));
      }
    }

    if (emailSet.size === 0) return `No encontré direcciones de email para "${query}".`;

    const lines = [...emailSet].map(e => nameMap[e] ? `${nameMap[e]} <${e}>` : e);
    return `Emails encontrados para "${query}":\n${lines.join('\n')}`;
  } catch (err: any) {
    return `Error al buscar contactos: ${err.message}`;
  }
}
