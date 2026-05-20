import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { google } from 'googleapis';
import { requireUser } from '../auth/middleware.js';
import { tokensToClient } from '../auth/google.js';

const DAY_NAMES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

function getMondayOfCurrentWeek(): Date {
  const now = new Date();
  const day = now.getDay(); // 0=Sun … 6=Sat
  // Go back to Monday (if Sunday, go back 6 days; otherwise go back day-1)
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
  // "2026-05-03T10:00:00-03:00" → "10:00"
  const m = iso.match(/T(\d{2}:\d{2})/);
  return m ? m[1] : '';
}

export async function calendarRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /calendar/week
  fastify.get(
    '/calendar/week',
    { preHandler: requireUser },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = request.user!;
        if (!user.google_tokens) {
          return reply.status(403).send({ error: 'Google account not connected' });
        }

        const authClient = tokensToClient(user.google_tokens, user._id);
        const calendarApi = google.calendar({ version: 'v3', auth: authClient });

        // Build 7-day window starting Monday
        const weekStart = getMondayOfCurrentWeek();
        const weekEnd = new Date(weekStart);
        weekEnd.setDate(weekStart.getDate() + 6);
        weekEnd.setHours(23, 59, 59, 999);

        const timeMin = weekStart.toISOString();
        const timeMax = weekEnd.toISOString();

        // Build the 7 WeekDay slots up front
        const weekDays = Array.from({ length: 7 }, (_, i) => {
          const d = new Date(weekStart);
          d.setDate(weekStart.getDate() + i);
          return {
            day: DAY_NAMES[d.getDay()],
            date: formatDateKey(d),
            count: 0,
            day_num: d.getDate(),
          };
        });
        const dateSet = new Set(weekDays.map((d) => d.date));

        // Fetch all calendars
        let calPageToken: string | undefined;
        const calendars: Array<{ id: string; summary: string; colorId: string }> = [];

        do {
          const calRes = await calendarApi.calendarList.list({ pageToken: calPageToken });
          for (const cal of calRes.data.items ?? []) {
            if (cal.id) {
              calendars.push({
                id: cal.id,
                summary: cal.summary ?? '',
                colorId: cal.colorId ?? '',
              });
            }
          }
          calPageToken = calRes.data.nextPageToken ?? undefined;
        } while (calPageToken);

        // Fetch events from all calendars in parallel
        type FrontendEvent = {
          datetime: string;
          date: string;
          start_time: string;
          end_time: string;
          title: string;
          all_day: boolean;
          color_id: string;
          calendar_name?: string;
          url?: string;
        };

        const allEvents: FrontendEvent[] = [];

        await Promise.all(
          calendars.map(async (cal) => {
            try {
              let pageToken: string | undefined;
              do {
                const evRes = await calendarApi.events.list({
                  calendarId: cal.id,
                  timeMin,
                  timeMax,
                  singleEvents: true,
                  maxResults: 250,
                  orderBy: 'startTime',
                  pageToken,
                });
                for (const ev of evRes.data.items ?? []) {
                  const isAllDay = Boolean(ev.start?.date && !ev.start?.dateTime);
                  const startIso = ev.start?.dateTime ?? ev.start?.date ?? '';
                  const endIso = ev.end?.dateTime ?? ev.end?.date ?? '';
                  const date = startIso.slice(0, 10);

                  // Only include events that fall within our week window
                  if (!dateSet.has(date)) continue;

                  allEvents.push({
                    datetime: startIso,
                    date,
                    start_time: isAllDay ? '' : parseTime(startIso),
                    end_time: isAllDay ? '' : parseTime(endIso),
                    title: ev.summary ?? '(Sin título)',
                    all_day: isAllDay,
                    color_id: ev.colorId ?? cal.colorId ?? '',
                    calendar_name: cal.summary,
                    url: ev.htmlLink ?? undefined,
                  });
                }
                pageToken = evRes.data.nextPageToken ?? undefined;
              } while (pageToken);
            } catch (err) {
              console.error(`[Calendar] Failed to fetch events for ${cal.id}:`, err);
            }
          })
        );

        // Sort by datetime
        allEvents.sort((a, b) => a.datetime.localeCompare(b.datetime));

        console.log(`[Calendar] user=${user._id} calendars=${calendars.length} events=${allEvents.length} week=${formatDateKey(weekStart)}..${formatDateKey(weekEnd)}`);

        // Count events per day
        for (const ev of allEvents) {
          const slot = weekDays.find((d) => d.date === ev.date);
          if (slot) slot.count++;
        }

        return reply.send({
          by_day: weekDays,         // WeekDay[] array — frontend can .reduce() this
          events: allEvents,        // CalendarEvent[] with correct field names
          week_start: formatDateKey(weekStart),
        });
      } catch (err) {
        console.error('[Calendar] /calendar/week error:', err);
        return reply.status(500).send({ error: 'Failed to fetch calendar events' });
      }
    }
  );
}
