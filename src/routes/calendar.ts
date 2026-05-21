import { Router, Request, Response } from 'express';
import { google } from 'googleapis';
import { requireUser } from '../auth/middleware.js';
import { tokensToClient } from '../auth/google.js';

const DAY_NAMES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const router = Router();

function getMondayOfCurrentWeek(): Date {
  const now = new Date();
  const day = now.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  const monday = new Date(now);
  monday.setDate(now.getDate() + diff);
  monday.setHours(0, 0, 0, 0);
  return monday;
}

function formatDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function parseTime(iso: string): string {
  const m = iso.match(/T(\d{2}:\d{2})/);
  return m ? m[1] : '';
}

// GET /calendar/week
router.get('/calendar/week', requireUser, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    if (!user.google_tokens) {
      res.status(403).json({ error: 'Google account not connected' });
      return;
    }

    const authClient = tokensToClient(user.google_tokens, user._id);
    const calendarApi = google.calendar({ version: 'v3', auth: authClient });

    const weekStart = getMondayOfCurrentWeek();
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 6);
    weekEnd.setHours(23, 59, 59, 999);

    const timeMin = weekStart.toISOString();
    const timeMax = weekEnd.toISOString();

    const weekDays = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(weekStart);
      d.setDate(weekStart.getDate() + i);
      return { day: DAY_NAMES[d.getDay()], date: formatDateKey(d), count: 0, day_num: d.getDate() };
    });
    const dateSet = new Set(weekDays.map((d) => d.date));

    let calPageToken: string | undefined;
    const calendars: Array<{ id: string; summary: string; colorId: string }> = [];
    do {
      const calRes = await calendarApi.calendarList.list({ pageToken: calPageToken });
      for (const cal of calRes.data.items ?? []) {
        if (cal.id) calendars.push({ id: cal.id, summary: cal.summary ?? '', colorId: cal.colorId ?? '' });
      }
      calPageToken = calRes.data.nextPageToken ?? undefined;
    } while (calPageToken);

    type FrontendEvent = {
      datetime: string; date: string; start_time: string; end_time: string;
      title: string; all_day: boolean; color_id: string; calendar_name?: string; url?: string;
    };
    const allEvents: FrontendEvent[] = [];

    await Promise.all(calendars.map(async (cal) => {
      try {
        let pageToken: string | undefined;
        do {
          const evRes = await calendarApi.events.list({
            calendarId: cal.id, timeMin, timeMax, singleEvents: true, maxResults: 250, orderBy: 'startTime', pageToken,
          });
          for (const ev of evRes.data.items ?? []) {
            const isAllDay = Boolean(ev.start?.date && !ev.start?.dateTime);
            const startIso = ev.start?.dateTime ?? ev.start?.date ?? '';
            const endIso = ev.end?.dateTime ?? ev.end?.date ?? '';
            const date = startIso.slice(0, 10);
            if (!dateSet.has(date)) continue;
            allEvents.push({
              datetime: startIso, date,
              start_time: isAllDay ? '' : parseTime(startIso),
              end_time: isAllDay ? '' : parseTime(endIso),
              title: ev.summary ?? '(Sin título)', all_day: isAllDay,
              color_id: ev.colorId ?? cal.colorId ?? '',
              calendar_name: cal.summary, url: ev.htmlLink ?? undefined,
            });
          }
          pageToken = evRes.data.nextPageToken ?? undefined;
        } while (pageToken);
      } catch (err) {
        console.error(`[Calendar] Failed to fetch events for ${cal.id}:`, err);
      }
    }));

    allEvents.sort((a, b) => a.datetime.localeCompare(b.datetime));
    for (const ev of allEvents) {
      const slot = weekDays.find((d) => d.date === ev.date);
      if (slot) slot.count++;
    }

    console.log(`[Calendar] user=${user._id} calendars=${calendars.length} events=${allEvents.length}`);
    res.json({ by_day: weekDays, events: allEvents, week_start: formatDateKey(weekStart) });
  } catch (err) {
    console.error('[Calendar] /calendar/week error:', err);
    res.status(500).json({ error: 'Failed to fetch calendar events' });
  }
});

export default router;
