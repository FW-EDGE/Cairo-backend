import { Router, Request, Response } from 'express';
import { requireUser } from '../auth/middleware.js';
import { buildContextBlock } from '../services/rag.js';
import { getLlmResponse, getLlmStream, REPORT_TOOL, SEARCH_DRIVE_TOOL, READ_FILE_TOOL } from '../services/llm.js';
import { broadcastJson } from '../websocket.js';
import { getGoogleTokens } from '../db/users.js';
import { createDriveFolder, copyDriveFile, updateFileContent, searchDriveFiles, getFileContent } from '../services/driveActions.js';

const router = Router();

// POST /chat  — responds as SSE stream to avoid proxy timeouts on long LLM calls
router.post('/chat', requireUser, async (req: Request, res: Response) => {
  // Open SSE connection immediately — prevents Render/Cloudflare timeout
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable Nginx/Cloudflare buffering
  // Disable Nagle algorithm so small SSE chunks are flushed immediately
  (req.socket as any)?.setNoDelay?.(true);
  res.flushHeaders();

  /** Send a structured SSE event */
  const send = (payload: object) => res.write(`data: ${JSON.stringify(payload)}\n\n`);

  /** Keepalive comment every 20 s — prevents proxy read-timeout during LLM wait */
  const keepalive = setInterval(() => res.write(': ping\n\n'), 20_000);

  try {
    const user = req.user!;
    const { message, history = [] } = req.body as { message: string; history?: any[] };
    if (!message) { send({ type: 'error', message: 'message is required' }); return; }

    // ── RAG context (wrapped so an OOM in embedding search doesn't kill the server) ───
    const { context: contextBlock, items: ragItems } = await buildContextBlock(user._id, message, user.tier, history)
      .catch((err) => {
        console.error('[Chat] RAG error (continuing without context):', err?.message ?? err);
        return { context: '', items: [] as any[] };
      });

    const isReportEnabled = user.skills?.['report_generation'] === true;
    const tools = isReportEnabled ? [REPORT_TOOL, SEARCH_DRIVE_TOOL, READ_FILE_TOOL] : [];

    let customContext = contextBlock;
    if (isReportEnabled) {
      customContext += `\n\n### SKILL: GENERACIÓN DE INFORMES ACTIVADO\n`;
      if (user.reportSettings?.prompt) customContext += `\nINSTRUCCIONES ESPECÍFICAS:\n${user.reportSettings.prompt}`;
    } else {
      customContext += `\n\n### RESTRICCIÓN IMPORTANTE: GENERACIÓN DE INFORMES DESACTIVADA\n`;
      customContext += `Si el usuario te pide un informe o un SOW NO OFREZCAS AYUDA. `;
      customContext += `Decí que no tenés activada la habilidad de "Generación de Informes" y que debe activarla desde Skills.\n`;
    }

    let messages: any[] = [...history.slice(-18), { role: 'user', content: message }];
    const tokens = await getGoogleTokens(user._id);

    let iteration   = 0;
    let finalReportData: any = null;

    // ── Tool-call loop ────────────────────────────────────────────────────────
    while (iteration < 5) {
      // ── No tools: stream tokens directly from OpenAI (true SSE) ─────────────
      if (tools.length === 0) {
        for await (const token of getLlmStream(messages, customContext)) {
          send({ type: 'delta', content: token });
        }
        if (ragItems.length > 0) {
          broadcastJson({
            type: 'highlight_nodes',
            label: message.slice(0, 60),
            nodes: ragItems.map(i => ({ name: i.name, url: i.url, file_type: i.type, source: i.source })),
          });
        }
        send({ type: 'done', tier: user.tier, reportData: finalReportData });
        return;
      }

      // ── Tools enabled: non-streaming call to capture tool_calls ─────────────
      const { content, tool_calls } = await getLlmResponse(messages, customContext, tools);

      if (!tool_calls || tool_calls.length === 0) {
        // Final answer after tool iterations — content already fetched, send as-is
        send({ type: 'done', tier: user.tier, response: content, reportData: finalReportData });
        if (ragItems.length > 0) {
          broadcastJson({
            type: 'highlight_nodes',
            label: message.slice(0, 60),
            nodes: ragItems.map(i => ({ name: i.name, url: i.url, file_type: i.type, source: i.source })),
          });
        }
        return;
      }

      // ── Execute tools ─────────────────────────────────────────────────────
      messages.push({ role: 'assistant', content, tool_calls });

      for (const call of tool_calls) {
        const args = JSON.parse(call.function.arguments);
        let toolResult = '';

        const toolLabels: Record<string, string> = {
          search_drive:    'Buscando en Drive…',
          read_drive_file: 'Leyendo archivo…',
          generate_report: 'Generando informe…',
        };
        send({ type: 'status', message: toolLabels[call.function.name] ?? 'Procesando…' });

        if (!tokens) {
          toolResult = 'Error: No Google tokens found. Ask user to re-login.';
        } else {
          try {
            if (call.function.name === 'search_drive') {
              const files = await searchDriveFiles(user._id, tokens, args.query);
              toolResult = files.map((f: any) => `Name: ${f.name}, ID: ${f.id}`).join('\n') || 'No files found.';
            } else if (call.function.name === 'read_drive_file') {
              toolResult = await getFileContent(user._id, tokens, args.fileId);
            } else if (call.function.name === 'generate_report') {
              const { projectName, reportContent } = args;
              const parentId  = user.reportSettings?.parentFolderId;
              const templateId = user.reportSettings?.templateId;
              if (!parentId || !templateId) {
                toolResult = 'Error: Missing Folder or Template ID in settings.';
              } else {
                const folderId = await createDriveFolder(user._id, tokens, projectName, parentId);
                const fileId   = await copyDriveFile(user._id, tokens, templateId, projectName, folderId);
                await updateFileContent(user._id, tokens, fileId, reportContent);
                finalReportData = { fileId, folderId, projectName };
                toolResult = `SUCCESS: Report generated. File ID: ${fileId}`;
              }
            }
          } catch (err: any) {
            toolResult = `Error executing tool: ${err.message}`;
          }
        }

        messages.push({ role: 'tool', tool_call_id: call.id, name: call.function.name, content: toolResult });
      }

      iteration++;
    }

    send({ type: 'done', tier: user.tier, response: 'CAIRO ha excedido los pasos permitidos para procesar esta solicitud.' });
  } catch (err: any) {
    const errMsg = err?.message ?? String(err);
    console.error('[Chat] Error:', errMsg);
    // Surface the actual error to the client so it's visible in the chat bubble
    send({ type: 'error', message: `Error interno: ${errMsg.slice(0, 200)}` });
  } finally {
    clearInterval(keepalive);
    res.end();
  }
});

export default router;
