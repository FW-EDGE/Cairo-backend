export interface Skill {
  id: string;
  name: string;
  description: string;
  icon: string;
  category: 'Workspace' | 'Communication' | 'Analysis' | 'Tools' | 'Advanced' | 'Productividad' | 'Interfaz';
}

export const AVAILABLE_SKILLS: Skill[] = [
  // ── Conectores Google (activos por defecto) ──────────────────────────────
  {
    id: 'gmail_assistant',
    name: 'Asistente de Gmail',
    description: 'Permite a CAIRO buscar y leer tus emails en tiempo real para responder preguntas sobre conversaciones, remitentes y adjuntos.',
    icon: 'Mail',
    category: 'Productividad',
  },
  {
    id: 'calendar_management',
    name: 'Calendario y Reuniones',
    description: 'CAIRO puede consultar tu agenda, crear eventos e invitar participantes directamente desde el chat.',
    icon: 'Calendar',
    category: 'Productividad',
  },
  {
    id: 'drive_assistant',
    name: 'Asistente de Drive',
    description: 'Permite a CAIRO buscar archivos y leer documentos de Google Drive para responder preguntas sobre su contenido.',
    icon: 'HardDrive',
    category: 'Productividad',
  },
  // ── Skills avanzadas ─────────────────────────────────────────────────────
  {
    id: 'report_generation',
    name: 'Generación de Informes',
    description: 'Automatiza la creación de informes basados en un template y una carpeta de destino específica.',
    icon: 'FileText',
    category: 'Productividad',
  },
  {
    id: 'jira_integration',
    name: 'Jira: Gestión de Proyectos',
    description: 'Permite al agente interactuar con tus tickets, sprints y proyectos de Jira.',
    icon: 'Trello',
    category: 'Tools',
  },
  {
    id: 'taqtic_management',
    name: 'Taqtic: Gestión de Tareas',
    description: 'Permite al agente crear y listar tareas en tu instancia de Taqtic.',
    icon: 'CheckSquare',
    category: 'Tools',
  },
  {
    id: 'data_analysis_pro',
    name: 'Análisis de Datos Avanzado',
    description: 'Capacidad para procesar archivos complejos y generar insights estadísticos.',
    icon: 'BarChart2',
    category: 'Analysis',
  },
  {
    id: 'deep_research',
    name: 'Investigación Profunda',
    description: 'El agente dedicará más tiempo a navegar múltiples fuentes para respuestas complejas.',
    icon: 'Search',
    category: 'Advanced',
  },
  {
    id: 'voice_interaction',
    name: 'Interacción por Voz',
    description: 'Habilita la capacidad de conversar con CAIRO mediante voz en tiempo real.',
    icon: 'Mic',
    category: 'Interfaz',
  },
];
