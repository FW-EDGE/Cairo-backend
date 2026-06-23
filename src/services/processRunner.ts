import OpenAI from 'openai';
import { ObjectId } from 'mongodb';
import { Response } from 'express';
import { getConfig } from '../config.js';
import { orchAgentsCol, orchSkillsCol, orchToolsCol, orchProcessesCol } from '../db/orchestration.js';
import type { OrchTool } from '../db/orchestration.js';
import { getGoogleTokens } from '../db/users.js';
import { searchGmail, readEmail } from './gmailActions.js';
import { getFileContent } from './driveActions.js';
import { searchContacts, listCalendarEvents, createCalendarEvent } from './calendarActions.js';
import { buildContextBlock } from './rag.js';
import { callTactiqTool, isTactiqTool, getTactiqOpenAIToolDefs, getTactiqToolLabel } from './tactiqClient.js';

// ── Tool registry ─────────────────────────────────────────────────────────────

const BUILTIN_GOOGLE_FNS = new Set([
  'search_gmail', 'read_email', 'read_drive_file',
  'search_contacts', 'list_calendar_events', 'create_calendar_event',
]);

function buildOpenAIToolDef(tool: OrchTool) {
  const properties: Record<string, any> = {};
  const required: string[] = [];
  for (const p of (tool.inputs ?? [])) {
    const baseType = p.type === 'string[]' ? 'array' : p.type === 'number' ? 'number' : 'string';
    properties[p.name] = {
      type: baseType,
      description: p.desc,
      ...(baseType === 'array' ? { items: { type: 'string' } } : {}),
    };
    if (p.required) required.push(p.name);
  }
  return {
    type: 'function' as const,
    function: {
      name: tool.fn,
      description: tool.description || tool.label,
      parameters: { type: 'object', properties, required },
    },
  };
}

async function loadUserToolDefs(toolFns: string[], userId: string): Promise<any[]> {
  if (toolFns.length === 0) return [];
  try {
    const col  = await orchToolsCol();
    const docs = await col.find({ user_id: new ObjectId(userId), fn: { $in: toolFns } }).toArray();
    const byFn = new Map(docs.map(d => [d.fn, d]));
    return toolFns.map(fn => byFn.get(fn)).filter(Boolean).map(t => buildOpenAIToolDef(t!));
  } catch { return []; }
}

const TOOL_LABELS: Record<string, string> = {
  search_gmail:          '📧 Buscando en Gmail…',
  read_email:            '📧 Leyendo email…',
  read_drive_file:       '📄 Leyendo archivo de Drive…',
  search_contacts:       '👤 Buscando contacto…',
  list_calendar_events:  '📅 Consultando calendario…',
  create_calendar_event: '📅 Creando evento en calendario…',
};


async function dispatchHttpTool(tool: OrchTool, args: any): Promise<string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (tool.auth_type === 'api_key' && tool.notes) {
    headers['Authorization'] = `Bearer ${tool.notes}`;
  }
  const timeout = tool.timeout_ms ? parseInt(tool.timeout_ms, 10) : 15_000;
  const ctrl    = new AbortController();
  const timer   = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res  = await fetch(tool.endpoint, {
      method: 'POST', headers, body: JSON.stringify(args), signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) return `Error HTTP ${res.status}: ${text.slice(0, 300)}`;
    return text;
  } finally {
    clearTimeout(timer);
  }
}

async function dispatchTool(
  fn:     string,
  args:   any,
  userId: string,
  tokens: any,
): Promise<string> {
  try {
    // Tactiq MCP tools — prefix: tactiq_
    if (isTactiqTool(fn)) {
      const toolName = fn.replace(/^tactiq_/, '');
      return await callTactiqTool(userId, toolName, args);
    }

    if (BUILTIN_GOOGLE_FNS.has(fn)) {
      if (!tokens) return 'Error: No hay tokens de Google disponibles. Reconectá tu cuenta.';
      switch (fn) {
        case 'search_gmail':
          return await searchGmail(userId, tokens, args.query ?? '', args.max_results ?? 10);
        case 'read_email':
          return await readEmail(userId, tokens, args.message_id ?? '');
        case 'read_drive_file':
          return await getFileContent(userId, tokens, args.fileId ?? '');
        case 'search_contacts':
          return await searchContacts(userId, tokens, args.query ?? '');
        case 'list_calendar_events':
          return await listCalendarEvents(
            userId, tokens,
            args.max_results ?? 10,
            args.time_min, args.time_max, args.query,
          );
        case 'create_calendar_event':
          return await createCalendarEvent(userId, tokens, {
            summary:     args.summary,
            description: args.description,
            location:    args.location,
            start:       args.start,
            end:         args.end,
            timezone:    args.timezone,
            attendees:   args.attendees ?? [],
          });
      }
    }

    // Custom tool: look up from DB and dispatch via HTTP endpoint
    const col  = await orchToolsCol();
    const tool = await col.findOne({ fn, user_id: new ObjectId(userId) });
    if (!tool?.endpoint) {
      return `Tool "${fn}" no tiene endpoint configurado.`;
    }
    return await dispatchHttpTool(tool, args);

  } catch (err: any) {
    const msg = err.message ?? String(err);
    return `Error en ${fn}: ${msg.slice(0, 300)}`;
  }
}

// ── Agent resolution ──────────────────────────────────────────────────────────

interface AgentConfig {
  id:           string;
  label:        string;
  systemPrompt: string;
  toolFns:      string[];
  model:        string;
}

const STATIC_AGENTS: Record<string, Omit<AgentConfig, 'id'>> = {
  'agent-gmail': {
    label:        'Gmail Agent',
    systemPrompt: 'Sos un agente especializado en Gmail. Tu trabajo es buscar emails, leer su contenido y extraer información relevante. Usá las herramientas de búsqueda para encontrar los mensajes correctos antes de leerlos. Respondé siempre en el idioma del usuario.',
    toolFns:      ['search_gmail', 'read_email'],
    model:        'gpt-4o',
  },
  'agent-drive': {
    label:        'Drive Agent',
    systemPrompt: 'Sos un agente especializado en Google Drive. Tu trabajo es acceder y leer el contenido de archivos y documentos. Extraé información relevante, resumí documentos y respondé preguntas basándote en su contenido. Respondé siempre en el idioma del usuario.',
    toolFns:      ['read_drive_file'],
    model:        'gpt-4o',
  },
  'agent-calendar': {
    label:        'Calendar Agent',
    systemPrompt: 'Sos un agente especializado en Google Calendar y Contactos. Tu trabajo es consultar la agenda, crear eventos, buscar disponibilidad y gestionar contactos. Siempre confirmá los detalles antes de crear eventos. Respondé siempre en el idioma del usuario.',
    toolFns:      ['list_calendar_events', 'create_calendar_event', 'search_contacts'],
    model:        'gpt-4o',
  },
  'agent-tactiq': {
    label:        'Meeting Agent',
    systemPrompt: 'Sos un agente especializado en reuniones vía Tactiq. Podés buscar transcripciones, obtener el contenido completo de una reunión y resumir lo hablado. Respondé siempre en el idioma del usuario.',
    toolFns:      ['tactiq_search_meeting_transcripts', 'tactiq_get_meeting_transcript', 'tactiq_list_meetings'],
    model:        'gpt-4o',
  },
  // Legacy fallback — kept so old processes referencing agent-cairo don't break
  'agent-cairo': {
    label:        'CAIRO Main',
    systemPrompt: 'Sos CAIRO, un agente de asistencia general con acceso a Gmail, Drive y Calendar del usuario. Completá la tarea asignada con precisión y detalle.',
    toolFns:      ['search_gmail', 'read_email', 'read_drive_file', 'search_contacts', 'list_calendar_events', 'create_calendar_event'],
    model:        'gpt-4o',
  },
};

// Map non-OpenAI model names to available OpenAI models
function resolveOAIModel(model: string): string {
  const m: Record<string, string> = {
    'gpt-4o':            'gpt-4o',
    'gpt-4o-mini':       'gpt-4o-mini',
    'claude-sonnet-4-6': 'gpt-4o',
    'claude-haiku-4-5':  'gpt-4o-mini',
    'grok-beta':         'gpt-4o',
  };
  return m[model] ?? 'gpt-4o';
}

async function resolveAgent(agentId: string, userId: string): Promise<AgentConfig | null> {
  // 1. Try DB
  try {
    if (ObjectId.isValid(agentId)) {
      const col      = await orchAgentsCol();
      const userOid  = new ObjectId(userId);
      const dbAgent  = await col.findOne({ _id: new ObjectId(agentId), user_id: userOid });

      if (dbAgent) {
        const skillsCol = await orchSkillsCol();
        const toolsCol  = await orchToolsCol();

        const skills = dbAgent.skill_ids.length > 0
          ? await skillsCol.find({
              _id: { $in: dbAgent.skill_ids.filter(id => ObjectId.isValid(id)).map(id => new ObjectId(id)) },
            }).toArray()
          : [];

        // Separate integration skills (→ tools) from behavioral skills (→ prompt injection)
        const integrationSkills = skills.filter(s => !s.skill_category || s.skill_category === 'integration');
        const behavioralSkills  = skills.filter(s => s.skill_category === 'behavioral');

        const allToolIds = integrationSkills.flatMap(s => s.tool_ids);
        const tools = allToolIds.length > 0
          ? await toolsCol.find({
              _id: { $in: allToolIds.filter(id => ObjectId.isValid(id)).map(id => new ObjectId(id)) },
            }).toArray()
          : [];

        // Build system prompt: agent base + behavioral skill instructions
        const systemParts: string[] = [
          dbAgent.system_prompt?.trim() || `Sos ${dbAgent.label}. Completá la tarea asignada.`,
        ];
        for (const sk of behavioralSkills) {
          if (sk.prompt?.trim()) {
            systemParts.push(`\n\n---\nSKILL: ${sk.label}\n${sk.prompt.trim()}`);
          }
        }

        return {
          id:           dbAgent._id!.toString(),
          label:        dbAgent.label,
          systemPrompt: systemParts.join(''),
          toolFns:      tools.map(t => t.fn).filter(Boolean),
          model:        dbAgent.model || 'gpt-4o',
        };
      }
    }
  } catch { /* fall through */ }

  // 2. Static fallback
  const st = STATIC_AGENTS[agentId];
  return st ? { id: agentId, ...st } : null;
}

// ── Single agent execution (streaming generator) ──────────────────────────────

type AgentStepEvent =
  | { type: 'delta';        content: string }
  | { type: 'tool_call';    tool: string; label: string; args: any }
  | { type: 'tool_result';  tool: string; ok: boolean; preview: string }
  | { type: 'agent_output'; output: string };

async function* runAgentStep(
  agent:               AgentConfig,
  input:               string,
  context:             string,
  tokens:              any,
  userId:              string,
  ragContext?:         string,
  processInstructions?: string,
): AsyncGenerator<AgentStepEvent> {
  const openai   = getOpenAI();
  const model    = resolveOAIModel(agent.model);

  const regularFns = agent.toolFns.filter(fn => !isTactiqTool(fn));
  const tactiqFns  = agent.toolFns.filter(fn => isTactiqTool(fn));

  const [regularDefs, tactiqDefs] = await Promise.all([
    loadUserToolDefs(regularFns, userId),
    tactiqFns.length > 0
      ? getTactiqOpenAIToolDefs(userId).catch(() => [] as any[])
      : Promise.resolve([] as any[]),
  ]);
  const toolDefs = [...regularDefs, ...tactiqDefs];

  const nowStr = new Date().toLocaleString('es-AR', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZone: 'America/Argentina/Buenos_Aires',
  });

  const systemParts: string[] = [agent.systemPrompt];
  if (processInstructions?.trim()) {
    systemParts.push(`\n\n---\nOBJETIVO DEL PROCESO:\n${processInstructions.trim()}`);
  }
  if (ragContext?.trim()) {
    systemParts.push(`\n\n---\nCONTEXTO INDEXADO (Drive / Gmail del usuario):\n${ragContext.trim()}`);
  }
  if (context?.trim()) {
    systemParts.push(`\n\n---\nCONTEXTO DEL PASO ANTERIOR:\n${context.trim()}`);
  }
  const systemContent = systemParts.join('');

  let messages: any[] = [
    { role: 'user', content: `[Fecha actual: ${nowStr}]\n\n${input}` },
  ];

  let fullOutput = '';

  for (let iter = 0; iter < 6; iter++) {
    const stream = await openai.chat.completions.create({
      model,
      messages:       [{ role: 'system', content: systemContent }, ...messages],
      max_tokens:     4096,
      temperature:    0.5,
      tools:          toolDefs.length > 0 ? toolDefs : undefined,
      stream:         true,
      stream_options: { include_usage: true },
    });

    const tcAcc: Record<number, { id: string; name: string; arguments: string }> = {};
    let assistantContent = '';

    try {
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        if (!delta) continue;

        if (delta.content) {
          assistantContent += delta.content;
          fullOutput       += delta.content;
          yield { type: 'delta', content: delta.content };
        }

        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            if (!tcAcc[tc.index]) tcAcc[tc.index] = { id: '', name: '', arguments: '' };
            if (tc.id)                    tcAcc[tc.index].id        += tc.id;
            if (tc.function?.name)        tcAcc[tc.index].name      += tc.function.name;
            if (tc.function?.arguments)   tcAcc[tc.index].arguments += tc.function.arguments;
          }
        }
      }
    } catch (streamErr: any) {
      const msg = (streamErr?.message ?? String(streamErr)).toLowerCase();
      // Render drops gzip-compressed responses mid-stream → treat as end of stream
      if (msg.includes('premature close') || msg.includes('premature_close') || msg.includes('err_stream')) {
        console.warn('[Agent] OpenAI stream premature close — using accumulated content');
      } else {
        throw streamErr;
      }
    }

    const calls = Object.values(tcAcc).filter(tc => tc.name);
    if (calls.length === 0) break;

    messages.push({
      role:       'assistant',
      content:    assistantContent || null,
      tool_calls: calls.map(c => ({
        id: c.id, type: 'function',
        function: { name: c.name, arguments: c.arguments },
      })),
    });

    for (const call of calls) {
      let args: any = {};
      try { args = JSON.parse(call.arguments); } catch { /* ignore parse errors */ }

      yield {
        type:  'tool_call',
        tool:  call.name,
        label: TOOL_LABELS[call.name] ?? (isTactiqTool(call.name) ? getTactiqToolLabel(call.name) : `⚙️ ${call.name}…`),
        args,
      };

      const result  = await dispatchTool(call.name, args, userId, tokens);
      const ok      = !result.startsWith('Error');
      const preview = result.slice(0, 280) + (result.length > 280 ? '…' : '');

      yield { type: 'tool_result', tool: call.name, ok, preview };

      messages.push({
        role:         'tool',
        tool_call_id: call.id,
        name:         call.name,
        content:      result,
      });
    }
  }

  yield { type: 'agent_output', output: fullOutput };
}

// ── OpenAI client (lazy) ──────────────────────────────────────────────────────

let _openai: OpenAI | null = null;
function getOpenAI(): OpenAI {
  if (!_openai) {
    const cfg = getConfig();
    _openai = new OpenAI({
      apiKey:         cfg.llm.openai.api_key,
      defaultHeaders: { 'Accept-Encoding': 'identity' },
    });
  }
  return _openai;
}

// ── Chat-compatible runner ────────────────────────────────────────────────────
// Maps process events to the existing chat SSE format so the chat UI
// renders process execution inline without any frontend changes.

export async function runProcessInChat(
  send:      (payload: object) => void,
  processId: string,
  input:     string,
  userId:    string,
): Promise<void> {
  const process = await loadProcess(processId, userId);
  if (!process) {
    send({ type: 'error', message: `Proceso "${processId}" no encontrado.` });
    return;
  }

  const agentConfigs = await resolveAgents(process.agent_ids, userId, send);
  if (agentConfigs.length === 0) {
    send({ type: 'error', message: 'No se pudieron resolver los agentes del proceso.' });
    return;
  }

  const [tokens, ragResult] = await Promise.all([
    getGoogleTokens(userId),
    buildContextBlock(userId, input || process.label, 'pro', []).catch(() => ({ context: '', items: [], intent: {} as any })),
  ]);

  const ragContext         = ragResult.context;
  const processInstructions = process.prompt ?? '';
  const mode: 'sequential' | 'parallel' = process.mode ?? 'sequential';

  send({ type: 'status', message: `⚙️ Proceso **${process.label}** · ${mode === 'sequential' ? 'Secuencial' : 'Paralelo'} · ${agentConfigs.length} agente${agentConfigs.length > 1 ? 's' : ''}` });

  if (mode === 'sequential') {
    const outputs: string[] = [];

    for (let i = 0; i < agentConfigs.length; i++) {
      const agent       = agentConfigs[i];
      const stepContext = outputs.map((o, j) => `## Salida del Paso ${j + 1} (${agentConfigs[j].label})\n${o}`).join('\n\n');

      send({ type: 'status', message: `🤖 Paso ${i + 1}/${agentConfigs.length}: **${agent.label}**` });
      if (i > 0) send({ type: 'delta', content: '\n\n---\n\n' });

      let agentOutput = '';
      for await (const ev of runAgentStep(agent, input, stepContext, tokens, userId, ragContext, processInstructions)) {
        if (ev.type === 'delta') {
          send({ type: 'delta', content: ev.content });
          agentOutput += ev.content;
        } else if (ev.type === 'tool_call') {
          send({ type: 'status', message: ev.label });
        } else if (ev.type === 'agent_output') {
          agentOutput = ev.output;
        }
      }
      outputs.push(agentOutput);
    }

  } else {
    const results: string[] = new Array(agentConfigs.length).fill('');
    agentConfigs.forEach((a) =>
      send({ type: 'status', message: `🤖 ${a.label} iniciando…` })
    );

    await Promise.all(agentConfigs.map(async (agent, i) => {
      for await (const ev of runAgentStep(agent, input, '', tokens, userId, ragContext, processInstructions)) {
        if (ev.type === 'tool_call') {
          send({ type: 'status', message: `[${agent.label}] ${ev.label}` });
        } else if (ev.type === 'agent_output') {
          results[i] = ev.output;
        }
      }
    }));

    for (let i = 0; i < agentConfigs.length; i++) {
      if (i > 0) send({ type: 'delta', content: '\n\n---\n\n' });
      send({ type: 'delta', content: `**${agentConfigs[i].label}**\n\n${results[i]}` });
    }
  }
}

// ── Shared helpers ────────────────────────────────────────────────────────────

async function loadProcess(processId: string, userId: string): Promise<any> {
  try {
    if (!ObjectId.isValid(processId)) return null;
    const col = await orchProcessesCol();
    return col.findOne({ _id: new ObjectId(processId), user_id: new ObjectId(userId) });
  } catch { return null; }
}

async function resolveAgents(
  agentIds: string[],
  userId:   string,
  send:     (p: object) => void,
): Promise<AgentConfig[]> {
  const configs: AgentConfig[] = [];
  for (const aid of agentIds) {
    const cfg = await resolveAgent(aid, userId);
    if (cfg) configs.push(cfg);
    else send({ type: 'status', message: `⚠️ Agente "${aid}" no encontrado, se saltea.` });
  }
  return configs;
}

// ── Main entry point ──────────────────────────────────────────────────────────

export async function runProcess(
  res:       Response,
  processId: string,
  input:     string,
  userId:    string,
): Promise<void> {
  const send = (payload: object) => res.write(`data: ${JSON.stringify(payload)}\n\n`);

  const process = await loadProcess(processId, userId);
  if (!process) {
    send({ type: 'error', message: `Proceso "${processId}" no encontrado.` });
    return;
  }

  if ((process.agent_ids ?? []).length === 0) {
    send({ type: 'error', message: 'El proceso no tiene agentes configurados.' });
    return;
  }

  const agentConfigs = await resolveAgents(process.agent_ids, userId, send);
  if (agentConfigs.length === 0) {
    send({ type: 'error', message: 'No se pudieron resolver los agentes del proceso.' });
    return;
  }

  const [tokens, ragResult] = await Promise.all([
    getGoogleTokens(userId),
    buildContextBlock(userId, input || process.label, 'pro', []).catch(() => ({ context: '', items: [], intent: {} as any })),
  ]);

  const ragContext          = ragResult.context;
  const processInstructions = process.prompt ?? '';

  send({
    type:   'process_start',
    label:  process.label,
    mode:   process.mode,
    agents: agentConfigs.map(a => a.label),
    total:  agentConfigs.length,
  });

  const mode: 'sequential' | 'parallel' = process.mode ?? 'sequential';

  try {
    if (mode === 'sequential') {
      const outputs: string[] = [];

      for (let i = 0; i < agentConfigs.length; i++) {
        const agent       = agentConfigs[i];
        const stepContext = outputs.map((o, j) => `## Salida del Paso ${j + 1} (${agentConfigs[j].label})\n${o}`).join('\n\n');

        send({ type: 'agent_start', step: i, total: agentConfigs.length, label: agent.label, model: agent.model });

        let agentOutput = '';
        for await (const ev of runAgentStep(agent, input, stepContext, tokens, userId, ragContext, processInstructions)) {
          if (ev.type === 'delta') {
            send({ type: 'delta', step: i, content: ev.content });
          } else if (ev.type === 'tool_call') {
            send({ type: 'tool_call', step: i, tool: ev.tool, label: ev.label });
          } else if (ev.type === 'tool_result') {
            send({ type: 'tool_result', step: i, tool: ev.tool, ok: ev.ok, preview: ev.preview });
          } else if (ev.type === 'agent_output') {
            agentOutput = ev.output;
          }
        }

        outputs.push(agentOutput);
        send({ type: 'agent_done', step: i, output: agentOutput });
      }

      send({ type: 'process_done', output: outputs[outputs.length - 1] ?? '' });

    } else {
      const results: string[] = new Array(agentConfigs.length).fill('');

      await Promise.all(agentConfigs.map(async (agent, i) => {
        send({ type: 'agent_start', step: i, total: agentConfigs.length, label: agent.label, model: agent.model });

        for await (const ev of runAgentStep(agent, input, '', tokens, userId, ragContext, processInstructions)) {
          if (ev.type === 'delta') {
            send({ type: 'delta', step: i, content: ev.content });
          } else if (ev.type === 'tool_call') {
            send({ type: 'tool_call', step: i, tool: ev.tool, label: ev.label });
          } else if (ev.type === 'tool_result') {
            send({ type: 'tool_result', step: i, tool: ev.tool, ok: ev.ok, preview: ev.preview });
          } else if (ev.type === 'agent_output') {
            results[i] = ev.output;
          }
        }

        send({ type: 'agent_done', step: i, output: results[i] });
      }));

      const combined = agentConfigs
        .map((a, i) => `## ${a.label}\n${results[i]}`)
        .join('\n\n---\n\n');

      send({ type: 'process_done', output: combined });
    }
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    console.error('[Process] runProcess error:', msg);
    send({ type: 'error', message: `Error en el proceso: ${msg.slice(0, 200)}` });
  }
}
