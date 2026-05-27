import OpenAI from 'openai';
import { getConfig } from '../config.js';

export const CAIRO_SYSTEM_BASE = `Eres CAIRO (Centralized AI for Resource Optimization), un agente de inteligencia artificial avanzado y servicial.
Tu objetivo es ayudar al usuario a gestionar sus recursos, archivos y tareas de manera eficiente.
Sos profesional, inteligente y capaz de automatizar flujos de trabajo complejos.
Cuando buscás y encontrás archivos en Drive, estos automáticamente se resaltan en el mapa neural del dashboard. Si el usuario pide "mostralos en el mapa" o algo similar luego de una búsqueda, hacé una nueva búsqueda con los mismos términos para que aparezcan en el mapa — no digas que no podés hacerlo.`;

export const CAIRO_CONTEXT_INSTRUCTIONS = `
INSTRUCCIONES DE CONTEXTO:
- Se te ha proporcionado información relevante de los archivos de Drive y correos de Gmail del usuario, extraída del índice local.
- SIEMPRE basá tu respuesta en ese contexto cuando sea relevante para la pregunta.
- Si el contexto contiene la respuesta, úsala directamente. No inventes ni complementes con información genérica.
- Cuando cites información del contexto, mencioná la fuente (nombre del archivo o asunto del mail).
- Si el contexto NO tiene información relevante para la pregunta, decilo claramente.

REGLA CRÍTICA SOBRE HERRAMIENTAS:
- Si el contexto ya contiene archivos de Drive o correos de Gmail relevantes para lo que pide el usuario, USÁ ESE CONTEXTO DIRECTAMENTE. NO llames a search_drive ni a search_gmail. Esos datos ya fueron buscados antes de esta conversación.
- Solo usá search_drive o search_gmail si el contexto dice explícitamente "(No se encontraron fragmentos relevantes.)" o si el usuario pide búsqueda en tiempo real ("buscá ahora", "actualizá", "revisá de nuevo").
- search_drive y search_gmail son costosas y lentas. El contexto indexado es la fuente primaria.
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

export const SEARCH_GMAIL_TOOL = {
  type: 'function',
  function: {
    name: 'search_gmail',
    description: 'Busca emails en Gmail EN TIEMPO REAL. IMPORTANTE: si el contexto ya contiene correos relevantes, NO uses esta herramienta — respondé con ese contexto. Usá esta tool SOLO cuando el contexto no tiene la respuesta o el usuario pide buscar algo específico que no está en el contexto. Soporta sintaxis Gmail: "from:nombre", "subject:tema", "after:YYYY/MM/DD", etc.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Consulta de búsqueda Gmail. Ejemplos: "from:juan after:2024/05/20", "subject:reunión is:unread", "from:ariel saban"',
        },
        max_results: {
          type: 'number',
          description: 'Cantidad máxima de emails a retornar (default: 10, máximo: 20)',
        },
      },
      required: ['query'],
    },
  },
} as const;

export const READ_EMAIL_TOOL = {
  type: 'function',
  function: {
    name: 'read_email',
    description: 'Lee el contenido completo de un email específico dado su ID de Gmail. Usá esta tool cuando ya tenés el ID del mensaje y querés leer su contenido completo.',
    parameters: {
      type: 'object',
      properties: {
        message_id: {
          type: 'string',
          description: 'El ID del mensaje de Gmail (obtenido de una búsqueda previa)',
        },
      },
      required: ['message_id'],
    },
  },
} as const;

export const SEARCH_DRIVE_TOOL = {
  type: 'function',
  function: {
    name: 'search_drive',
    description: 'Busca archivos en Google Drive EN TIEMPO REAL. IMPORTANTE: si el contexto ya contiene archivos de Drive relevantes, NO uses esta herramienta — respondé con ese contexto directamente. Usá esta tool SOLO cuando el contexto dice "(No se encontraron fragmentos relevantes.)" o cuando el usuario pide explícitamente una búsqueda nueva. Acepta texto simple como "MODO" o "informe enero".',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Texto a buscar. Puede ser texto simple como "MODO" o "informe enero", o sintaxis avanzada de Drive API.',
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

export const SEARCH_CONTACTS_TOOL = {
  type: 'function',
  function: {
    name: 'search_contacts',
    description: 'Busca la dirección de email de una persona por su nombre. Usá esta herramienta ANTES de crear un evento o enviar un mail cuando no tenés el email exacto del destinatario.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Nombre completo o parcial de la persona (ej: "Ninosca Mogollon")',
        },
      },
      required: ['query'],
    },
  },
} as const;

export const LIST_CALENDAR_EVENTS_TOOL = {
  type: 'function',
  function: {
    name: 'list_calendar_events',
    description: 'Lista eventos del calendario del usuario, tanto pasados como futuros. Podés filtrar por rango de fechas y buscar por email de asistente, palabras clave del título o descripción. Para buscar quién estuvo en reuniones pasadas, usá time_min y time_max apuntando al pasado junto con query.',
    parameters: {
      type: 'object',
      properties: {
        max_results: {
          type: 'number',
          description: 'Cantidad máxima de eventos a retornar (default: 10, máximo: 50)',
        },
        time_min: {
          type: 'string',
          description: 'Fecha de inicio del rango en ISO 8601 (ej: "2026-03-01T00:00:00"). Para buscar eventos pasados, usá una fecha anterior a hoy.',
        },
        time_max: {
          type: 'string',
          description: 'Fecha de fin del rango en ISO 8601 (ej: "2026-05-27T23:59:59"). Opcional.',
        },
        query: {
          type: 'string',
          description: 'Búsqueda de texto libre. Filtra eventos que contengan este texto en: email de asistente, nombre del asistente, título del evento o descripción. Ej: "jsolis@gruposalinas.com.mx" para buscar reuniones con esa persona.',
        },
      },
    },
  },
} as const;

export const CREATE_CALENDAR_EVENT_TOOL = {
  type: 'function',
  function: {
    name: 'create_calendar_event',
    description: 'Crea un evento en Google Calendar y envía invitaciones automáticas a los participantes. Si no tenés el email de algún invitado, primero usá search_contacts para encontrarlo.',
    parameters: {
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          description: 'Título del evento',
        },
        description: {
          type: 'string',
          description: 'Descripción u orden del día del evento (opcional)',
        },
        location: {
          type: 'string',
          description: 'Ubicación o link de videollamada (opcional)',
        },
        start: {
          type: 'string',
          description: 'Fecha y hora de inicio en ISO 8601, SIN zona horaria (ej: "2026-05-29T16:00:00"). Se asume horario de Buenos Aires.',
        },
        end: {
          type: 'string',
          description: 'Fecha y hora de fin en ISO 8601 (ej: "2026-05-29T17:00:00"). Si no se especifica, el evento dura 1 hora.',
        },
        timezone: {
          type: 'string',
          description: 'Zona horaria IANA (default: "America/Argentina/Buenos_Aires")',
        },
        attendees: {
          type: 'array',
          items: { type: 'string' },
          description: 'Lista de emails de los invitados (ej: ["ninosca@empresa.com", "otra@empresa.com"])',
        },
      },
      required: ['summary', 'start'],
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
    if (chunk.usage && onUsage) {
      onUsage({ input: chunk.usage.prompt_tokens ?? 0, output: chunk.usage.completion_tokens ?? 0 });
    }
    const token = chunk.choices[0]?.delta?.content;
    if (token) yield token;
  }
}

export type StreamEvent =
  | { type: 'delta';      content: string }
  | { type: 'tool_calls'; calls: Array<{ id: string; function: { name: string; arguments: string } }> }
  | { type: 'usage';      usage: LlmUsage };

/**
 * Streaming call that also handles tool calls.
 *
 * Yields:
 *  - { type: 'delta', content }     — text tokens as they arrive (true streaming)
 *  - { type: 'tool_calls', calls }  — when the model wants to call tools
 *  - { type: 'usage', usage }       — token counts at end of stream
 *
 * The caller should:
 *  1. Forward 'delta' events to the SSE client.
 *  2. On 'tool_calls': execute the tools, push results to messages, call again.
 *  3. Use 'usage' for billing.
 */
export async function* getLlmStreamWithTools(
  messages:    any[],
  contextBlock: string,
  tools:        any[],
): AsyncGenerator<StreamEvent> {
  const client = getOpenAI();
  const stream = await client.chat.completions.create({
    model:          getModel(),
    messages:       buildFormattedMessages(messages, contextBlock),
    max_tokens:     4096,
    temperature:    0.5,
    tools:          tools.length > 0 ? tools : undefined,
    stream:         true,
    stream_options: { include_usage: true },
  });

  // Accumulate tool call fragments (the model streams arguments character by character)
  const tcAcc: Record<number, { id: string; name: string; arguments: string }> = {};
  let assistantContent = '';

  for await (const chunk of stream) {
    if (chunk.usage) {
      yield { type: 'usage', usage: { input: chunk.usage.prompt_tokens ?? 0, output: chunk.usage.completion_tokens ?? 0 } };
    }

    const delta = chunk.choices[0]?.delta;
    if (!delta) continue;

    // Stream text tokens directly to client
    if (delta.content) {
      assistantContent += delta.content;
      yield { type: 'delta', content: delta.content };
    }

    // Accumulate tool call fragments
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        if (!tcAcc[tc.index]) tcAcc[tc.index] = { id: '', name: '', arguments: '' };
        if (tc.id)                tcAcc[tc.index].id        += tc.id;
        if (tc.function?.name)    tcAcc[tc.index].name      += tc.function.name;
        if (tc.function?.arguments) tcAcc[tc.index].arguments += tc.function.arguments;
      }
    }
  }

  const calls = Object.values(tcAcc).filter(tc => tc.name);
  if (calls.length > 0) {
    yield {
      type:  'tool_calls',
      calls: calls.map(tc => ({ id: tc.id, function: { name: tc.name, arguments: tc.arguments } })),
    };
  }
}
