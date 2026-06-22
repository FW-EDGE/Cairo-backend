import { ObjectId } from 'mongodb';
import {
  orchSkillsCol, orchToolsCol, orchAgentsCol,
  OrchSkill, OrchTool, OrchAgent,
} from '../db/orchestration.js';

// ── Behavioral skill definitions (reused by seed + reseed endpoint) ───────────

type BehavioralDef = Omit<OrchSkill, '_id' | 'user_id' | 'created_at' | 'updated_at'>;

export const BEHAVIORAL_SKILL_DEFS: BehavioralDef[] = [
  {
    label: 'Redacción Formal', skill_id: 'redaccion_formal',
    description: 'Aplica tono formal en español (usted) para emails, propuestas e informes.',
    skill_category: 'behavioral',
    prompt: `## Tono y registro
Respondé y redactá siempre en español formal, usando "usted" como tratamiento de segunda persona. Evitá contracciones, voseo y lenguaje coloquial.

## Estructura de documentos escritos
- Comenzá con un párrafo de contexto breve (1-2 oraciones).
- Desarrollá el cuerpo con párrafos cortos y precisos (máx. 4 oraciones cada uno).
- Cerrá siempre con un llamado a la acción claro o un párrafo de cierre formal.
- Usá "Estimado/a [nombre]:" como saludo y "Quedo a su disposición." como cierre en emails.

## Estilo
- No uses emojis ni lenguaje informal.
- No uses términos técnicos sin definirlos primero.
- Priorizá la claridad y la concisión sobre la extensión.
- Cuando sea relevante, indicá plazos y responsables de forma explícita.`,
    trigger: 'Cuando el usuario pida redactar emails, propuestas comerciales, informes o cualquier comunicación formal.',
    provider: 'Custom', auth_type: 'None', skill_type: 'Built-in',
    endpoint: '', rate_limit: '', tool_ids: [],
    color: '#a78bfa', notes: '', is_enabled: true, is_builtin: true,
  },
  {
    label: 'Síntesis Ejecutiva', skill_id: 'sintesis_ejecutiva',
    description: 'Resume emails, documentos y conversaciones en formato ejecutivo.',
    skill_category: 'behavioral',
    prompt: `## Objetivo
Resumí cualquier contenido extenso (email, documento, hilo, reunión) en un formato ejecutivo claro y accionable.

## Formato de síntesis
Usá siempre esta estructura:

**📌 En una línea:** [Una oración que captura la esencia del contenido]

**Puntos clave:**
- [Máx. 5 puntos, ordenados por importancia]

**Acción requerida:** [Qué necesita hacer el usuario, si aplica. Si no hay acción, omití esta sección.]

**Contexto adicional:** [Solo si hay información de fondo importante que el usuario deba conocer. Opcional.]

## Reglas
- El resumen nunca debe superar el 20% del largo original.
- No incluyas información redundante ni ejemplos del texto fuente.
- Si el contenido no requiere acción, aclaralo explícitamente.
- Sé directo: el usuario lee esto para decidir qué hacer a continuación.`,
    trigger: 'Cuando el usuario pida resumir, sintetizar o dar un overview de emails, documentos, conversaciones o reuniones.',
    provider: 'Custom', auth_type: 'None', skill_type: 'Built-in',
    endpoint: '', rate_limit: '', tool_ids: [],
    color: '#a78bfa', notes: '', is_enabled: true, is_builtin: true,
  },
  {
    label: 'Extractor de Action Items', skill_id: 'extractor_action_items',
    description: 'Detecta y estructura tareas y compromisos de cualquier texto.',
    skill_category: 'behavioral',
    prompt: `## Objetivo
Identificá y estructurá todos los action items, compromisos y pendientes presentes en el texto analizado.

## Formato de salida
Para cada action item encontrado, mostrá:

- [ ] **[Qué]** — descripción concisa de la tarea
  - 👤 **Responsable:** [nombre o "No especificado"]
  - 📅 **Fecha límite:** [fecha o "No especificada"]
  - 🔗 **Contexto:** [de dónde viene este item, ej: "Email de Juan - Asunto: Revisión propuesta"]

## Reglas de extracción
- Incluí solo compromisos explícitos o implícitos claros — no interpretaciones forzadas.
- Si un texto no contiene action items, respondé: "No se encontraron action items en este contenido."
- Priorizá los items donde el usuario es el responsable al principio de la lista.
- Ordená por fecha límite (más próxima primero) cuando esté disponible.
- Si encontrás dependencias entre items, indicalo con ↳ en el item dependiente.`,
    trigger: 'Cuando el usuario pida extraer tareas, action items, pendientes o compromisos de emails, reuniones o conversaciones.',
    provider: 'Custom', auth_type: 'None', skill_type: 'Built-in',
    endpoint: '', rate_limit: '', tool_ids: [],
    color: '#a78bfa', notes: '', is_enabled: true, is_builtin: true,
  },
  {
    label: 'Triaje de Urgencia', skill_id: 'triage_urgencia',
    description: 'Clasifica emails, tareas o mensajes por urgencia e importancia.',
    skill_category: 'behavioral',
    prompt: `## Objetivo
Clasificá cada item según su urgencia e importancia usando una matriz simplificada.

## Categorías
🔴 **CRÍTICO** — Urgente + Importante: requiere atención hoy, tiene consecuencias significativas si se demora.
🟠 **PRIORITARIO** — No urgente + Importante: debe planificarse esta semana, impacto estratégico.
🟡 **ATENDER** — Urgente + No importante: responder rápido pero puede delegarse o automatizarse.
⚪ **BACKLOG** — No urgente + No importante: puede postergarse, revisar cuando haya tiempo libre.

## Formato de respuesta
Para cada item clasificado:

**[CATEGORÍA] [emoji]** — [Título o asunto del item]
> [1 oración explicando el criterio de clasificación]

Al final, mostrá un resumen:
- 🔴 Crítico: N items
- 🟠 Prioritario: N items
- 🟡 Atender: N items
- ⚪ Backlog: N items

## Criterios de clasificación
- **Urgencia**: ¿Tiene fecha límite en las próximas 24-48h? ¿Hay alguien esperando respuesta?
- **Importancia**: ¿Afecta objetivos clave del negocio, relaciones importantes o decisiones estratégicas?`,
    trigger: 'Cuando el usuario tenga una lista de emails, tareas o mensajes y necesite saber por dónde empezar.',
    provider: 'Custom', auth_type: 'None', skill_type: 'Built-in',
    endpoint: '', rate_limit: '', tool_ids: [],
    color: '#a78bfa', notes: '', is_enabled: true, is_builtin: true,
  },
  {
    label: 'Respuestas Estructuradas', skill_id: 'respuestas_estructuradas',
    description: 'Formato consistente y escaneable para todas las respuestas.',
    skill_category: 'behavioral',
    prompt: `## Principios de formato
Todas tus respuestas deben ser fáciles de escanear visualmente. Aplicá estas reglas:

## Cuándo usar cada elemento
- **Negrita** → términos clave, nombres propios, valores importantes, decisiones
- *Itálica* → contexto, aclaraciones, términos técnicos la primera vez que aparecen
- \`código\` → IDs, fechas en formato ISO, parámetros, comandos, emails
- Listas con guión → items sin orden jerárquico (3 o más elementos)
- Listas numeradas → pasos secuenciales o prioridades ordenadas
- Tablas → comparaciones con 3+ atributos o 4+ items
- \`\`\`bloque\`\`\` → JSON, código, contenido de archivos, datos estructurados largos

## Estructura de respuesta
1. **Respuesta directa primero** — nunca empieces con contexto o explicaciones largas.
2. **Desarrollo** — solo si el usuario necesita entender el razonamiento.
3. **Próximos pasos** — solo si hay una acción clara a tomar.

## Longitud
- Respuesta simple: 1-3 oraciones o una lista corta.
- Respuesta compleja: secciones con headers \`##\`, sin exceder lo necesario.
- Nunca añadas conclusiones ni resúmenes al final de respuestas que ya son concisas.`,
    trigger: 'Siempre activo — define el estilo de formato de todas las respuestas del agente.',
    provider: 'Custom', auth_type: 'None', skill_type: 'Built-in',
    endpoint: '', rate_limit: '', tool_ids: [],
    color: '#a78bfa', notes: '', is_enabled: true, is_builtin: true,
  },
];

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

  // ── 4. Behavioral skills ──────────────────────────────────────────────────
  const behavioralSkills: OrchSkill[] = BEHAVIORAL_SKILL_DEFS.map(def => ({
    ...def, user_id: userId, created_at: now, updated_at: now,
  }));

  await skillsCol.insertMany(behavioralSkills);


  // ── 5. Built-in agents (3 specialized — one per skill) ────────────────────
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
