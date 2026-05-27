import { Router, Request, Response } from 'express';
import { requireUser } from '../auth/middleware.js';
import { buildContextBlock } from '../services/rag.js';
import {
  getLlmStreamWithTools, StreamEvent,
  REPORT_TOOL, READ_FILE_TOOL,
  SEARCH_GMAIL_TOOL, READ_EMAIL_TOOL,
  SEARCH_CONTACTS_TOOL, LIST_CALENDAR_EVENTS_TOOL, CREATE_CALENDAR_EVENT_TOOL,
} from '../services/llm.js';
import { broadcastJson } from '../websocket.js';
import { getGoogleTokens, incrementChatUsage, recordTokenUsage, TIER_LIMITS, Tier } from '../db/users.js';
import { createDriveFolder, copyDriveFile, updateFileContent, getFileContent } from '../services/driveActions.js';
import { searchGmail, readEmail } from '../services/gmailActions.js';
import { searchContacts, listCalendarEvents, createCalendarEvent } from '../services/calendarActions.js';

const router = Router();

// POST /chat  — responds as SSE stream
router.post('/chat', requireUser, async (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  (req.socket as any)?.setNoDelay?.(true);
  res.flushHeaders();

  const send = (payload: object) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
  const keepalive = setInterval(() => res.write(': ping\n\n'), 20_000);

  try {
    const user = req.user!;
    const { message, history = [] } = req.body as { message: string; history?: any[] };
    if (!message) { send({ type: 'error', message: 'message is required' }); return; }

    // ── Monthly quota check ───────────────────────────────────────────────────
    const tier  = (user.tier ?? 'free') as Tier;
    const limit = TIER_LIMITS[tier].chat_messages;
    const usage = user.usage ?? { chat_messages: 0, period_start: new Date().toISOString() };
    const daysSince = (Date.now() - new Date(usage.period_start).getTime()) / 86_400_000;
    const effectiveCount = daysSince >= 30 ? 0 : usage.chat_messages;

    if (effectiveCount >= limit) {
      const nextTier = tier === 'free' ? 'Pro' : tier === 'pro' ? 'Business' : null;
      send({ type: 'quota_exceeded', tier, limit, used: effectiveCount, nextTier });
      return;
    }

    await incrementChatUsage(user._id);

    // ── Skills (granular) ─────────────────────────────────────────────────────
    // Skills default to true when not explicitly set (new users get everything on).
    const sk = (id: string) => (user.skills?.[id] ?? true) === true;

    // ── RAG context ───────────────────────────────────────────────────────────
    const { context: contextBlock, items: ragItemsRaw, intent } = await buildContextBlock(user._id, message, user.tier, history)
      .catch((err) => {
        console.error('[Chat] RAG error:', err?.message ?? err);
        return { context: '', items: [] as any[], intent: { wantsMail: false, wantsDrive: false, wantsCalendar: false, wantsEverything: true } };
      });

    // Filter RAG items for the neural map highlight:
    // 1. Skills gate (drive_search / gmail_search must be on)
    // 2. Intent gate: only highlight the source type the user is asking about
    const ragItems = ragItemsRaw.filter(item => {
      // Skills check
      if (item.source === 'drive' && !sk('drive_search')) return false;
      if (item.source === 'gmail' && !sk('gmail_search')) return false;

      // Intent check — only show highlights relevant to what was asked
      if (!intent.wantsEverything) {
        if (item.source === 'gmail'  && !intent.wantsMail)  return false;
        if (item.source === 'drive'  && !intent.wantsDrive) return false;
      }
      return true;
    });

    // ── Current date/time ─────────────────────────────────────────────────────
    const nowStr = new Date().toLocaleString('es-AR', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      hour: '2-digit', minute: '2-digit', timeZone: 'America/Argentina/Buenos_Aires',
    });
    let customContext = `### FECHA Y HORA ACTUAL\n${nowStr} (hora de Buenos Aires)\n\n${contextBlock}`;

    const tools: any[] = [];
    const active: string[]   = [];
    const inactive: string[] = [];

    // Gmail
    if (sk('gmail_search'))    { tools.push(SEARCH_GMAIL_TOOL);           active.push('buscar emails'); }
    else                         inactive.push('buscar emails (gmail_search desactivado)');

    if (sk('gmail_read'))      { tools.push(READ_EMAIL_TOOL);             active.push('leer emails completos'); }
    else                         inactive.push('leer emails completos (gmail_read desactivado)');

    // Calendario
    if (sk('contacts_search')) { tools.push(SEARCH_CONTACTS_TOOL);       active.push('buscar contactos'); }
    else                         inactive.push('buscar contactos (contacts_search desactivado)');

    if (sk('calendar_read'))   { tools.push(LIST_CALENDAR_EVENTS_TOOL);  active.push('ver agenda'); }
    else                         inactive.push('ver agenda (calendar_read desactivado)');

    if (sk('calendar_create')) { tools.push(CREATE_CALENDAR_EVENT_TOOL); active.push('crear eventos'); }
    else                         inactive.push('crear eventos (calendar_create desactivado)');

    // Drive
    if (sk('drive_search'))    { active.push('buscar y listar archivos de Drive (usá el contexto indexado)'); }
    else                         inactive.push('buscar archivos de Drive (drive_search desactivado)');

    if (sk('drive_read'))      { tools.push(READ_FILE_TOOL);             active.push('leer contenido de archivos de Drive'); }
    else                         inactive.push('leer archivos de Drive (drive_read desactivado)');

    // Informe
    if (sk('report_generation')) {
      tools.push(REPORT_TOOL);
      active.push('generar informes');
      customContext += `\n\n### SKILL ACTIVA: GENERACIÓN DE INFORMES`;
      if (user.reportSettings?.prompt) customContext += `\nINSTRUCCIONES ESPECÍFICAS:\n${user.reportSettings.prompt}`;
    } else {
      customContext += `\n\n### RESTRICCIÓN: GENERACIÓN DE INFORMES DESACTIVADA\nSi el usuario te pide un informe o un SOW NO OFREZCAS AYUDA. Decí que no tenés activada la habilidad de "Generación de Informes" y que debe activarla desde Skills.`;
    }

    if (active.length)   customContext += `\n\n### CAPACIDADES ACTIVAS\n${active.map(a => `- ${a}`).join('\n')}`;
    if (inactive.length) customContext += `\n\n### CAPACIDADES DESACTIVADAS (no podés usarlas, indicá al usuario que las active desde Skills si las necesita)\n${inactive.map(a => `- ${a}`).join('\n')}`;

    const tokens = await getGoogleTokens(user._id);
    let messages: any[] = [...history.slice(-18), { role: 'user', content: message }];
    let finalReportData: any = null;

    const broadcastHighlight = () => {
      if (ragItems.length > 0) {
        broadcastJson({
          type:  'highlight_nodes',
          label: message.slice(0, 60),
          nodes: ragItems.map(i => ({ name: i.name, url: i.url, file_type: i.type })),
        });
      }
    };

    // ── Agentic loop (max 8 tool-call iterations) ─────────────────────────────
    for (let iteration = 0; iteration < 8; iteration++) {
      let assistantContent = '';
      let toolCallsReceived: StreamEvent & { type: 'tool_calls' } | null = null;

      // Stream with tools — tokens arrive live, tool_calls accumulate at end
      for await (const event of getLlmStreamWithTools(messages, customContext, tools)) {
        if (event.type === 'delta') {
          send({ type: 'delta', content: event.content });
          assistantContent += event.content;
        } else if (event.type === 'tool_calls') {
          toolCallsReceived = event;
        } else if (event.type === 'usage') {
          recordTokenUsage(user._id, { chat_input_tokens: event.usage.input, chat_output_tokens: event.usage.output }).catch(() => {});
        }
      }

      // No tool calls → final answer was already streamed token by token
      if (!toolCallsReceived || toolCallsReceived.calls.length === 0) {
        broadcastHighlight();
        send({ type: 'done', tier: user.tier, reportData: finalReportData });
        return;
      }

      // ── Execute tool calls ────────────────────────────────────────────────
      // Push assistant message with tool_calls so the model has context
      messages.push({
        role: 'assistant',
        content: assistantContent || null,
        tool_calls: toolCallsReceived.calls.map(c => ({
          id:       c.id,
          type:     'function',
          function: { name: c.function.name, arguments: c.function.arguments },
        })),
      });

      for (const call of toolCallsReceived.calls) {
        let args: any = {};
        try { args = JSON.parse(call.function.arguments); } catch { /* use empty */ }

        const toolLabels: Record<string, string> = {
          search_gmail:          '📧 Buscando en Gmail…',
          read_email:            '📧 Leyendo email…',
          search_drive:          '📂 Buscando en Drive…',
          read_drive_file:       '📄 Leyendo archivo…',
          search_contacts:       '👤 Buscando contacto…',
          list_calendar_events:  '📅 Consultando calendario…',
          create_calendar_event: '📅 Creando evento…',
          generate_report:       '📝 Generando informe…',
        };
        send({ type: 'status', message: toolLabels[call.function.name] ?? 'Procesando…' });

        let toolResult = '';
        if (!tokens) {
          toolResult = 'Error: No hay tokens de Google. El usuario debe volver a conectar su cuenta.';
        } else {
          try {
            if (call.function.name === 'search_gmail') {
              toolResult = await searchGmail(user._id, tokens, args.query ?? '', args.max_results ?? 10);

            } else if (call.function.name === 'read_email') {
              toolResult = await readEmail(user._id, tokens, args.message_id ?? '');

            } else if (call.function.name === 'read_drive_file') {
              toolResult = await getFileContent(user._id, tokens, args.fileId ?? '');

            } else if (call.function.name === 'search_contacts') {
              toolResult = await searchContacts(user._id, tokens, args.query ?? '');

            } else if (call.function.name === 'list_calendar_events') {
              toolResult = await listCalendarEvents(
                user._id, tokens,
                args.max_results ?? 10,
                args.time_min,
                args.time_max,
                args.query,
              );

            } else if (call.function.name === 'create_calendar_event') {
              toolResult = await createCalendarEvent(user._id, tokens, {
                summary:     args.summary,
                description: args.description,
                location:    args.location,
                start:       args.start,
                end:         args.end,
                timezone:    args.timezone,
                attendees:   args.attendees ?? [],
              });

            } else if (call.function.name === 'generate_report') {
              const { projectName, reportContent } = args;
              const parentId   = user.reportSettings?.parentFolderId;
              const templateId = user.reportSettings?.templateId;
              if (!parentId || !templateId) {
                toolResult = 'Error: Falta el ID de carpeta o template en la configuración.';
              } else {
                const folderId = await createDriveFolder(user._id, tokens, projectName, parentId);
                const fileId   = await copyDriveFile(user._id, tokens, templateId, projectName, folderId);
                await updateFileContent(user._id, tokens, fileId, reportContent);
                finalReportData = { fileId, folderId, projectName };
                toolResult = `ÉXITO: Informe generado. File ID: ${fileId}`;
              }
            }
          } catch (err: any) {
            const msg = err.message ?? '';
            if (msg.includes('SCOPE_MISSING')) {
              toolResult = msg; // already contains actionable instructions for the LLM
            } else {
              toolResult = `Error al ejecutar la herramienta: ${msg}`;
            }
            console.error(`[Chat] Tool ${call.function.name} error:`, msg);
          }
        }

        messages.push({
          role:         'tool',
          tool_call_id: call.id,
          name:         call.function.name,
          content:      toolResult,
        });
      }
      // Continue loop — model will stream its response after seeing tool results
    }

    broadcastHighlight();
    send({ type: 'done', tier: user.tier, response: 'CAIRO ha excedido los pasos permitidos para procesar esta solicitud.' });
  } catch (err: any) {
    const errMsg = err?.message ?? String(err);
    console.error('[Chat] Error:', errMsg);
    send({ type: 'error', message: `Error interno: ${errMsg.slice(0, 200)}` });
  } finally {
    clearInterval(keepalive);
    res.end();
  }
});

export default router;
