export interface Skill {
  id: string;
  name: string;
  description: string;
  icon: string;
  category: 'Workspace' | 'Communication' | 'Analysis' | 'Tools' | 'Advanced' | 'Productividad' | 'Interfaz';
  /** Visual grouping in the Skills modal */
  group?: string;
}

export const AVAILABLE_SKILLS: Skill[] = [

  // ── Gmail ────────────────────────────────────────────────────────────────
  {
    id: 'gmail_search',
    name: 'Buscar emails',
    description: 'CAIRO puede buscar en tu Gmail usando cualquier combinación de filtros: remitente, asunto, fecha, etiqueta, etc.',
    icon: 'MailSearch',
    category: 'Productividad',
    group: 'Gmail',
  },
  {
    id: 'gmail_read',
    name: 'Leer emails completos',
    description: 'CAIRO puede abrir y leer el contenido íntegro de un email, incluyendo cuerpo y adjuntos de texto.',
    icon: 'MailOpen',
    category: 'Productividad',
    group: 'Gmail',
  },

  // ── Calendario ───────────────────────────────────────────────────────────
  {
    id: 'calendar_read',
    name: 'Ver agenda',
    description: 'CAIRO puede consultar tus próximos eventos y verificar tu disponibilidad en Google Calendar.',
    icon: 'CalendarSearch',
    category: 'Productividad',
    group: 'Calendario',
  },
  {
    id: 'calendar_create',
    name: 'Crear eventos y reuniones',
    description: 'CAIRO puede crear eventos en tu calendario, definir horario y duración, y enviar invitaciones a los participantes.',
    icon: 'CalendarPlus',
    category: 'Productividad',
    group: 'Calendario',
  },
  {
    id: 'contacts_search',
    name: 'Buscar contactos',
    description: 'CAIRO puede encontrar la dirección de email de una persona por su nombre, escaneando tu historial de Gmail y tus contactos de Google.',
    icon: 'UserSearch',
    category: 'Productividad',
    group: 'Calendario',
  },

  // ── Google Drive ─────────────────────────────────────────────────────────
  {
    id: 'drive_search',
    name: 'Buscar archivos',
    description: 'CAIRO puede buscar archivos y carpetas en Google Drive por nombre, tipo, contenido o fecha de modificación.',
    icon: 'FolderSearch',
    category: 'Productividad',
    group: 'Drive',
  },
  {
    id: 'drive_read',
    name: 'Leer documentos',
    description: 'CAIRO puede leer el contenido de documentos de Google Drive (Google Docs, archivos de texto) para responder preguntas sobre su contenido.',
    icon: 'FileText',
    category: 'Productividad',
    group: 'Drive',
  },

  // ── Avanzado ─────────────────────────────────────────────────────────────
  {
    id: 'report_generation',
    name: 'Generación de Informes',
    description: 'Automatiza la creación de informes basados en un template y una carpeta de destino específica.',
    icon: 'FileOutput',
    category: 'Productividad',
    group: 'Avanzado',
  },
  {
    id: 'jira_integration',
    name: 'Jira: Gestión de Proyectos',
    description: 'Permite al agente interactuar con tus tickets, sprints y proyectos de Jira.',
    icon: 'Trello',
    category: 'Tools',
    group: 'Avanzado',
  },
  {
    id: 'taqtic_management',
    name: 'Taqtic: Gestión de Tareas',
    description: 'Permite al agente crear y listar tareas en tu instancia de Taqtic.',
    icon: 'CheckSquare',
    category: 'Tools',
    group: 'Avanzado',
  },
  {
    id: 'data_analysis_pro',
    name: 'Análisis de Datos Avanzado',
    description: 'Capacidad para procesar archivos complejos y generar insights estadísticos.',
    icon: 'BarChart2',
    category: 'Analysis',
    group: 'Avanzado',
  },
  {
    id: 'deep_research',
    name: 'Investigación Profunda',
    description: 'El agente dedicará más tiempo a navegar múltiples fuentes para respuestas complejas.',
    icon: 'Search',
    category: 'Advanced',
    group: 'Avanzado',
  },
  {
    id: 'voice_interaction',
    name: 'Interacción por Voz',
    description: 'Habilita la capacidad de conversar con CAIRO mediante voz en tiempo real.',
    icon: 'Mic',
    category: 'Interfaz',
    group: 'Interfaz',
  },
];

/** IDs de skills que tienen tool implementations reales */
export const FUNCTIONAL_SKILL_IDS = new Set([
  'gmail_search', 'gmail_read',
  'calendar_read', 'calendar_create', 'contacts_search',
  'drive_search', 'drive_read',
  'report_generation',
]);
