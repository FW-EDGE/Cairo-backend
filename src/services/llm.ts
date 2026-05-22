import OpenAI from 'openai';
import { getConfig } from '../config.js';

export const CAIRO_SYSTEM_BASE = `Eres CAIRO (Centralized AI for Resource Optimization), un agente de inteligencia artificial avanzado y servicial.
Tu objetivo es ayudar al usuario a gestionar sus recursos, archivos y tareas de manera eficiente.
Sos profesional, inteligente y capaz de automatizar flujos de trabajo complejos.`;

export const CAIRO_CONTEXT_INSTRUCTIONS = `
INSTRUCCIONES DE CONTEXTO:
- Se te ha proporcionado información relevante de los archivos de Drive y correos de Gmail del usuario.
- SIEMPRE basá tu respuesta en ese contexto cuando sea relevante para la pregunta.
- Si el contexto contiene la respuesta, úsala directamente. No inventes ni complementes con información genérica.
- Cuando cites información del contexto, mencioná la fuente (nombre del archivo o asunto del mail).
- Si el contexto NO tiene información relevante para la pregunta, decilo claramente.
- PARA INFORMES: Si el usuario pide un informe, asume un tono analítico, detallado y profesional. No escatimes en palabras; la calidad aquí se mide por la profundidad y la extensión del análisis.`;

let openaiClient: OpenAI | null = null;

function getOpenAI(): OpenAI {
  if (!openaiClient) {
    const config = getConfig();
    openaiClient = new OpenAI({
      apiKey: config.llm.openai.api_key,
    });
  }
  return openaiClient;
}

export function getModel(): string {
  const config = getConfig();
  return config.llm.openai.model || 'gpt-4o';
}

export const SEARCH_DRIVE_TOOL = {
  type: 'function',
  function: {
    name: 'search_drive',
    description: 'Busca archivos o carpetas en Google Drive usando una consulta de texto.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: "La consulta de búsqueda (ej: name contains 'SOW-NAC-')",
        },
      },
      required: ['query'],
    },
  },
} as const;

export const READ_FILE_TOOL = {
  type: 'function',
  function: {
    name: 'read_drive_file',
    description: 'Lee el contenido de texto de un archivo de Drive (Google Doc o Texto).',
    parameters: {
      type: 'object',
      properties: {
        fileId: {
          type: 'string',
          description: 'El ID del archivo a leer.',
        },
      },
      required: ['fileId'],
    },
  },
} as const;

export const REPORT_TOOL = {
  type: 'function',
  function: {
    name: 'generate_report',
    description: 'Genera un informe PROFESIONAL, EXTENSO y DETALLADO. El informe debe ser exhaustivo, analizando toda la información disponible para ofrecer un documento de alta calidad y gran longitud.',
    parameters: {
      type: 'object',
      properties: {
        projectName: {
          type: 'string',
          description: 'Nombre del proyecto o cliente.',
        },
        reportContent: {
          type: 'string',
          description: 'El contenido íntegro del informe. Debe ser extenso, con múltiples secciones, análisis profundo y detalles específicos extraídos del contexto.',
        },
      },
      required: ['projectName', 'reportContent'],
    },
  },
} as const;

function buildFormattedMessages(
  messages: any[],
  contextBlock: string,
): OpenAI.Chat.ChatCompletionMessageParam[] {
  let systemMessage = CAIRO_SYSTEM_BASE;
  if (contextBlock) {
    systemMessage +=
      `\n\n---\n${CAIRO_CONTEXT_INSTRUCTIONS}\n\n---\n\n` +
      `CONTEXTO DEL USUARIO:\n${contextBlock}`;
  }
  return [
    { role: 'system', content: systemMessage },
    ...messages.map((m) => {
      const msg: any = { role: m.role, content: m.content || null };
      if (m.tool_calls)    msg.tool_calls    = m.tool_calls;
      if (m.tool_call_id)  msg.tool_call_id  = m.tool_call_id;
      if (m.name)          msg.name          = m.name;
      return msg;
    }),
  ];
}

export interface LlmUsage { input: number; output: number; }

/** Non-streaming call — used for tool-call iterations where we need tool_calls back. */
export async function getLlmResponse(
  messages: any[],
  contextBlock: string,
  tools?: any[]
): Promise<{ content: string; tool_calls?: any[]; usage: LlmUsage }> {
  const client = getOpenAI();
  const completion = await client.chat.completions.create({
    model: getModel(),
    messages: buildFormattedMessages(messages, contextBlock),
    max_tokens: 2048,
    temperature: 0.5,
    tools: tools && tools.length > 0 ? tools : undefined,
  });
  const message = completion.choices[0]?.message;
  const usage: LlmUsage = {
    input:  completion.usage?.prompt_tokens     ?? 0,
    output: completion.usage?.completion_tokens ?? 0,
  };
  return { content: message?.content ?? '', tool_calls: message?.tool_calls, usage };
}

/** Streaming call — yields tokens; calls onUsage once the stream is done. */
export async function* getLlmStream(
  messages: any[],
  contextBlock: string,
  onUsage?: (u: LlmUsage) => void,
): AsyncGenerator<string> {
  const client = getOpenAI();
  const stream = await client.chat.completions.create({
    model: getModel(),
    messages: buildFormattedMessages(messages, contextBlock),
    max_tokens: 2048,
    temperature: 0.5,
    stream: true,
    stream_options: { include_usage: true },
  });
  for await (const chunk of stream) {
    // Last chunk carries the usage summary when stream_options.include_usage is true
    if (chunk.usage && onUsage) {
      onUsage({ input: chunk.usage.prompt_tokens ?? 0, output: chunk.usage.completion_tokens ?? 0 });
    }
    const token = chunk.choices[0]?.delta?.content;
    if (token) yield token;
  }
}
