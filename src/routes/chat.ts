import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { requireUser } from '../auth/middleware.js';
import { buildContextBlock } from '../services/rag.js';
import { getLlmResponse, REPORT_TOOL, SEARCH_DRIVE_TOOL, READ_FILE_TOOL } from '../services/llm.js';
import { broadcastJson } from '../websocket.js';
import { getGoogleTokens } from '../db/users.js';
import { 
  createDriveFolder, 
  copyDriveFile, 
  updateFileContent, 
  searchDriveFiles, 
  getFileContent 
} from '../services/driveActions.js';

export async function chatRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post('/chat', { preHandler: requireUser }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const user = request.user!;
      const { message, history = [] } = request.body as { message: string; history?: any[] };

      if (!message) return reply.status(400).send({ error: 'message is required' });

      const { context: contextBlock, items: ragItems } = await buildContextBlock(user._id, message, user.tier, history);

      const isReportEnabled = user.skills?.['report_generation'] === true;
      const tools = isReportEnabled ? [REPORT_TOOL, SEARCH_DRIVE_TOOL, READ_FILE_TOOL] : [];

      let customContext = contextBlock;
      if (isReportEnabled) {
        customContext += `\n\n### SKILL: GENERACIÓN DE INFORMES ACTIVADO\n`;
        if (user.reportSettings?.prompt) {
          customContext += `\nINSTRUCCIONES ESPECÍFICAS:\n${user.reportSettings.prompt}`;
        }
      } else {
        customContext += `\n\n### RESTRICCIÓN IMPORTANTE: GENERACIÓN DE INFORMES DESACTIVADA\n`;
        customContext += `Si el usuario te pide un informe, un SOW, o la creación de un documento, NO OFREZCAS AYUDA. \n`;
        customContext += `Debes responder estrictamente que NO tienes activada la habilidad de "Generación de Informes" y que el usuario debe activarla desde el panel de Skills en la interfaz.\n`;
        customContext += `No intentes simular el informe ni dar una respuesta genérica. Sé directo sobre la necesidad de activar el Skill.\n`;
      }

      let messages: any[] = [
        ...history.slice(-18),
        { role: 'user', content: message },
      ];

      const tokens = await getGoogleTokens(user._id);
      
      // --- TOOL LOOP ---
      let iteration = 0;
      let finalReportData: any = null;

      while (iteration < 5) { // Max 5 steps to avoid infinite loops
        const { content, tool_calls } = await getLlmResponse(messages, customContext, tools);
        
        if (!tool_calls || tool_calls.length === 0) {
          // If no tools, we are done
          if (ragItems.length > 0) {
            broadcastJson({
              type: 'highlight_nodes',
              label: message.slice(0, 60),
              nodes: ragItems.map(i => ({ name: i.name, url: i.url, file_type: i.type, source: i.source })),
            });
          }
          return reply.send({ response: content, tier: user.tier, reportData: finalReportData });
        }

        // Add assistant's message with tool_calls to history
        messages.push({ role: 'assistant', content, tool_calls });

        // Process each tool call
        for (const call of tool_calls) {
          const args = JSON.parse(call.function.arguments);
          let toolResult = "";

          if (!tokens) {
            toolResult = "Error: No Google tokens found. Ask user to re-login.";
          } else {
            try {
              if (call.function.name === 'search_drive') {
                const files = await searchDriveFiles(user._id, tokens, args.query);
                toolResult = files.map(f => `Name: ${f.name}, ID: ${f.id}`).join('\n') || "No files found.";
              } else if (call.function.name === 'read_drive_file') {
                toolResult = await getFileContent(user._id, tokens, args.fileId);
              } else if (call.function.name === 'generate_report') {
                const { projectName, reportContent } = args;
                const parentId = user.reportSettings?.parentFolderId;
                const templateId = user.reportSettings?.templateId;
                if (!parentId || !templateId) {
                  toolResult = "Error: Missing Folder or Template ID in settings.";
                } else {
                  const folderId = await createDriveFolder(user._id, tokens, projectName, parentId);
                  const fileId = await copyDriveFile(user._id, tokens, templateId, projectName, folderId);
                  await updateFileContent(user._id, tokens, fileId, reportContent);
                  finalReportData = { fileId, folderId, projectName };
                  toolResult = `SUCCESS: Report generated. File ID: ${fileId}`;
                }
              }
            } catch (err: any) {
              toolResult = `Error executing tool: ${err.message}`;
            }
          }

          // Add tool response to history
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            name: call.function.name,
            content: toolResult,
          });
        }

        iteration++;
      }

      return reply.send({ response: "CAIRO ha excedido los pasos permitidos para procesar esta solicitud.", tier: user.tier });
    } catch (err) {
      console.error('[Chat] Error:', err);
      return reply.status(500).send({ error: 'Internal Server Error' });
    }
  });
}
