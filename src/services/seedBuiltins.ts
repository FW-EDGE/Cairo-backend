import { ObjectId } from 'mongodb';
import {
  orchSkillsCol, orchToolsCol, orchAgentsCol,
  OrchSkill, OrchTool, OrchAgent,
} from '../db/orchestration.js';

// Seeds built-in skills, tools and agents for a user on first access.
// Idempotent — skips if built-in nodes already exist.
export async function seedBuiltins(userId: ObjectId): Promise<void> {
  const skillsCol = await orchSkillsCol();
  const existing  = await skillsCol.findOne({ user_id: userId, is_builtin: true });
  if (existing) return;

  const toolsCol  = await orchToolsCol();
  const agentsCol = await orchAgentsCol();
  const now = new Date();

  // ── 1. Skills ──────────────────────────────────────────────────────────────
  const gmailSkillDoc: OrchSkill = {
    user_id: userId, label: 'Gmail API', skill_id: 'gmail_api',
    description: 'Google Gmail REST API v1 — buscar, leer y enviar emails vía OAuth2.',
    prompt: '', provider: 'Google', auth_type: 'OAuth2', skill_type: 'REST API',
    endpoint: 'https://gmail.googleapis.com', rate_limit: '250 units/s',
    tool_ids: [], color: '#f472b6', notes: '',
    is_enabled: true, is_builtin: true, created_at: now, updated_at: now,
  };
  const driveSkillDoc: OrchSkill = {
    user_id: userId, label: 'Drive API', skill_id: 'drive_api',
    description: 'Google Drive API v3 — listar, leer y crear archivos vía REST.',
    prompt: '', provider: 'Google', auth_type: 'OAuth2', skill_type: 'REST API',
    endpoint: 'https://www.googleapis.com/drive/v3', rate_limit: '1000 req/100s',
    tool_ids: [], color: '#f472b6', notes: '',
    is_enabled: true, is_builtin: true, created_at: now, updated_at: now,
  };
  const calSkillDoc: OrchSkill = {
    user_id: userId, label: 'Calendar API', skill_id: 'calendar_api',
    description: 'Google Calendar API v3 — CRUD de eventos con OAuth2.',
    prompt: '', provider: 'Google', auth_type: 'OAuth2', skill_type: 'REST API',
    endpoint: 'https://www.googleapis.com/calendar/v3', rate_limit: '1000000 req/day',
    tool_ids: [], color: '#f472b6', notes: '',
    is_enabled: true, is_builtin: true, created_at: now, updated_at: now,
  };

  const [gmailId, driveId, calId] = await Promise.all([
    skillsCol.insertOne(gmailSkillDoc).then(r => r.insertedId),
    skillsCol.insertOne(driveSkillDoc).then(r => r.insertedId),
    skillsCol.insertOne(calSkillDoc).then(r => r.insertedId),
  ]);

  // ── 2. Tools ───────────────────────────────────────────────────────────────
  const toolDocs: OrchTool[] = [
    {
      user_id: userId, label: 'gmail.search', tool_id: 'gmail_search_tool',
      fn: 'search_gmail', description: 'Buscar emails en Gmail en tiempo real.',
      category: 'Gmail', skill_id: gmailId.toString(), color: '#4ade80',
      inputs: [
        { name: 'query',       type: 'string', required: true, desc: 'Sintaxis de búsqueda Gmail (from:, subject:, is:unread…)' },
        { name: 'max_results', type: 'number',               desc: 'Máximo de resultados (default 10)' },
      ],
      output: '{ id, subject, from, date, snippet }[]',
      endpoint: '', auth_type: 'none', rate_limit: '', timeout_ms: '', notes: '',
      is_builtin: true, created_at: now, updated_at: now,
    },
    {
      user_id: userId, label: 'gmail.read', tool_id: 'gmail_read_tool',
      fn: 'read_email', description: 'Leer el contenido completo de un email.',
      category: 'Gmail', skill_id: gmailId.toString(), color: '#4ade80',
      inputs: [
        { name: 'message_id', type: 'string', required: true, desc: 'ID del mensaje de Gmail (de una búsqueda previa)' },
      ],
      output: '{ subject, from, to, body, date }',
      endpoint: '', auth_type: 'none', rate_limit: '', timeout_ms: '', notes: '',
      is_builtin: true, created_at: now, updated_at: now,
    },
    {
      user_id: userId, label: 'drive.read', tool_id: 'drive_read_tool',
      fn: 'read_drive_file', description: 'Leer el contenido de texto de un archivo de Drive.',
      category: 'Drive', skill_id: driveId.toString(), color: '#4ade80',
      inputs: [
        { name: 'fileId', type: 'string', required: true, desc: 'ID del archivo en Google Drive' },
      ],
      output: 'string  // contenido en texto plano',
      endpoint: '', auth_type: 'none', rate_limit: '', timeout_ms: '', notes: '',
      is_builtin: true, created_at: now, updated_at: now,
    },
    {
      user_id: userId, label: 'contacts.search', tool_id: 'contacts_search_tool',
      fn: 'search_contacts', description: 'Buscar un contacto por nombre o email.',
      category: 'Calendar', skill_id: calId.toString(), color: '#4ade80',
      inputs: [
        { name: 'query', type: 'string', required: true, desc: 'Nombre o email a buscar' },
      ],
      output: '{ name, email }[]',
      endpoint: '', auth_type: 'none', rate_limit: '', timeout_ms: '', notes: '',
      is_builtin: true, created_at: now, updated_at: now,
    },
    {
      user_id: userId, label: 'calendar.list', tool_id: 'calendar_list_tool',
      fn: 'list_calendar_events', description: 'Listar eventos del calendario con filtros de fecha.',
      category: 'Calendar', skill_id: calId.toString(), color: '#4ade80',
      inputs: [
        { name: 'timeMin',    type: 'string', desc: 'Fecha inicio (ISO 8601)' },
        { name: 'timeMax',    type: 'string', desc: 'Fecha fin (ISO 8601)' },
        { name: 'query',      type: 'string', desc: 'Filtro de texto' },
        { name: 'maxResults', type: 'number', desc: 'Máximo de eventos (default 10)' },
      ],
      output: '{ id, summary, start, end, attendees }[]',
      endpoint: '', auth_type: 'none', rate_limit: '', timeout_ms: '', notes: '',
      is_builtin: true, created_at: now, updated_at: now,
    },
    {
      user_id: userId, label: 'calendar.create', tool_id: 'calendar_create_tool',
      fn: 'create_calendar_event', description: 'Crear un evento en Google Calendar.',
      category: 'Calendar', skill_id: calId.toString(), color: '#4ade80',
      inputs: [
        { name: 'summary',     type: 'string',   required: true, desc: 'Título del evento' },
        { name: 'start',       type: 'string',   required: true, desc: 'Inicio (ISO 8601)' },
        { name: 'end',         type: 'string',   required: true, desc: 'Fin (ISO 8601)' },
        { name: 'description', type: 'string',   desc: 'Descripción / agenda' },
        { name: 'location',    type: 'string',   desc: 'Lugar o link de Meet' },
        { name: 'attendees',   type: 'string[]', desc: 'Emails de los invitados' },
      ],
      output: '{ id, htmlLink }',
      endpoint: '', auth_type: 'none', rate_limit: '', timeout_ms: '', notes: '',
      is_builtin: true, created_at: now, updated_at: now,
    },
  ];

  const toolIds = await Promise.all(
    toolDocs.map(t => toolsCol.insertOne(t).then(r => r.insertedId.toString())),
  );

  // ── 3. Update skills with tool IDs ─────────────────────────────────────────
  await Promise.all([
    skillsCol.updateOne({ _id: gmailId }, { $set: { tool_ids: [toolIds[0], toolIds[1]] } }),
    skillsCol.updateOne({ _id: driveId }, { $set: { tool_ids: [toolIds[2]] } }),
    skillsCol.updateOne({ _id: calId },   { $set: { tool_ids: [toolIds[3], toolIds[4], toolIds[5]] } }),
  ]);

  // ── 4. Built-in agents (3 specialized — one per skill) ────────────────────
  const agentDocs: OrchAgent[] = [
    {
      user_id: userId, label: 'Gmail Agent', agent_id: 'agent-gmail',
      description: 'Especialista en Gmail. Busca, lee y resume emails con precisión.',
      system_prompt: 'Sos un agente especializado en Gmail. Tu trabajo es buscar emails, leer su contenido y extraer información relevante. Usá las herramientas de búsqueda para encontrar los mensajes correctos antes de leerlos. Respondé siempre en el idioma del usuario.',
      skill_ids: [gmailId.toString()],
      process_ids: [], model: 'gpt-4o', color: '#22d3ee',
      is_enabled: true, is_builtin: true, created_at: now, updated_at: now,
    },
    {
      user_id: userId, label: 'Drive Agent', agent_id: 'agent-drive',
      description: 'Especialista en Google Drive. Lee y analiza documentos y archivos.',
      system_prompt: 'Sos un agente especializado en Google Drive. Tu trabajo es acceder y leer el contenido de archivos y documentos. Extraé información relevante, resumí documentos y respondé preguntas basándote en su contenido. Respondé siempre en el idioma del usuario.',
      skill_ids: [driveId.toString()],
      process_ids: [], model: 'gpt-4o', color: '#22d3ee',
      is_enabled: true, is_builtin: true, created_at: now, updated_at: now,
    },
    {
      user_id: userId, label: 'Calendar Agent', agent_id: 'agent-calendar',
      description: 'Especialista en Google Calendar. Gestiona eventos, agenda y contactos.',
      system_prompt: 'Sos un agente especializado en Google Calendar y Contactos. Tu trabajo es consultar la agenda, crear eventos, buscar disponibilidad y gestionar contactos. Siempre confirmá los detalles antes de crear eventos. Respondé siempre en el idioma del usuario.',
      skill_ids: [calId.toString()],
      process_ids: [], model: 'gpt-4o', color: '#22d3ee',
      is_enabled: true, is_builtin: true, created_at: now, updated_at: now,
    },
  ];

  await agentsCol.insertMany(agentDocs);

  console.log(`[seedBuiltins] Built-in nodes seeded for user ${userId}`);
}
