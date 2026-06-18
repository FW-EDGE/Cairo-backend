import OpenAI from 'openai';
import { getConfig } from '../config.js';
import { getFileContent } from './driveActions.js';
import { GoogleTokens } from '../db/users.js';
import { TeamMember, getTeamMembers } from '../db/teamMembers.js';
import { PmProject } from '../db/pmProjects.js';
import { PmTask, createPmTask, deleteTasksByProject, getTasksByProject, getTasksByAssignee, updatePmTask } from '../db/pmTasks.js';

// ─── OpenAI client ────────────────────────────────────────────────────────────

let _client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!_client) {
    _client = new OpenAI({ apiKey: getConfig().llm.openai.api_key });
  }
  return _client;
}

// ─── Doc parsing ──────────────────────────────────────────────────────────────

interface ParsedTask {
  name: string;
  description: string;
  required_skills: string[];
  estimated_hours: number;
  dependencies_names: string[];
}

export async function parseDocToTasks(
  driveDocId: string,
  userId: string,
  tokens: GoogleTokens
): Promise<ParsedTask[]> {
  const content = await getFileContent(userId, tokens, driveDocId);
  const truncated = content.slice(0, 12000);

  const completion = await getClient().chat.completions.create({
    model: getConfig().llm.openai.model ?? 'gpt-4o',
    response_format: { type: 'json_object' },
    temperature: 0.2,
    max_tokens: 2048,
    messages: [
      {
        role: 'system',
        content:
          'Sos un asistente de gestión de proyectos. Extraés tareas de documentos de proyecto y devolvés JSON estructurado. ' +
          'Respondé únicamente con JSON válido, sin texto adicional.',
      },
      {
        role: 'user',
        content:
          'Analizá el siguiente documento de proyecto y extraé todas las tareas necesarias para completarlo.\n\n' +
          'Para cada tarea devolvé:\n' +
          '- name: nombre corto de la tarea (string)\n' +
          '- description: descripción breve (string)\n' +
          '- required_skills: skills tecnológicos o de dominio requeridos (array de strings, ej: ["React", "SQL", "Diseño UX"])\n' +
          '- estimated_hours: horas estimadas para completarla (número entero, mínimo 1)\n' +
          '- dependencies_names: nombres de otras tareas de las que depende (array de strings, puede estar vacío)\n\n' +
          'Formato de respuesta: { "tasks": [ { "name": "...", "description": "...", "required_skills": [], "estimated_hours": 8, "dependencies_names": [] } ] }\n\n' +
          'DOCUMENTO:\n' +
          truncated,
      },
    ],
  });

  const raw = completion.choices[0]?.message?.content ?? '{}';
  const parsed = JSON.parse(raw) as { tasks?: ParsedTask[] };
  return Array.isArray(parsed.tasks) ? parsed.tasks : [];
}

// ─── Availability ─────────────────────────────────────────────────────────────

function workingDaysBetween(start: string, end: string): number {
  let count = 0;
  const cur = new Date(start);
  const last = new Date(end);
  while (cur <= last) {
    const day = cur.getDay();
    if (day !== 0 && day !== 6) count++;
    cur.setDate(cur.getDate() + 1);
  }
  return Math.max(1, count);
}

function datesOverlap(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  return aStart <= bEnd && bStart <= aEnd;
}

export interface AvailabilityResult {
  totalAvailableHours: number;
  percentFree: number;
  committedHours: number;
  conflictingTaskNames: string[];
}

export async function calculateAvailability(
  member: TeamMember,
  ownerId: string,
  startDate: string,
  endDate: string,
  extraCommitments: Array<{ start_date: string; end_date: string; estimated_hours: number; name: string }> = []
): Promise<AvailabilityResult> {
  const assignedTasks = await getTasksByAssignee(member._id, ownerId);
  const allTasks = [
    ...assignedTasks.map(t => ({ start_date: t.start_date, end_date: t.end_date, estimated_hours: t.estimated_hours, name: t.name })),
    ...extraCommitments,
  ];

  const overlapping = allTasks.filter(t =>
    datesOverlap(t.start_date, t.end_date, startDate, endDate)
  );

  let committedHours = 0;
  for (const t of overlapping) {
    const taskDays = workingDaysBetween(t.start_date, t.end_date);
    const hoursPerDay = t.estimated_hours / taskDays;
    const overlapDays = workingDaysBetween(
      startDate > t.start_date ? startDate : t.start_date,
      endDate < t.end_date ? endDate : t.end_date
    );
    committedHours += hoursPerDay * overlapDays;
  }

  const totalDays = workingDaysBetween(startDate, endDate);
  const totalCapacity = member.capacity_hours_per_day * totalDays;
  const totalAvailableHours = Math.max(0, totalCapacity - committedHours);
  const percentFree = totalCapacity > 0 ? (totalAvailableHours / totalCapacity) * 100 : 0;

  return {
    totalAvailableHours,
    percentFree,
    committedHours,
    conflictingTaskNames: overlapping.map(t => t.name),
  };
}

// ─── Scoring ──────────────────────────────────────────────────────────────────

export interface MemberScore {
  member: TeamMember;
  skillScore: number;
  availScore: number;
  finalScore: number;
  matchedSkills: string[];
  missingSkills: string[];
}

export function scoreMemberForTask(
  member: TeamMember,
  task: PmTask,
  availability: AvailabilityResult
): MemberScore {
  const required = task.required_skills.map(s => s.toLowerCase());
  const has = member.skills.map(s => s.toLowerCase());

  const matchedSkills = task.required_skills.filter(s => has.includes(s.toLowerCase()));
  const missingSkills = task.required_skills.filter(s => !has.includes(s.toLowerCase()));

  const skillScore = required.length === 0 ? 1 : matchedSkills.length / required.length;
  const availScore = task.estimated_hours === 0
    ? 1
    : Math.min(1, availability.totalAvailableHours / task.estimated_hours);

  const finalScore = skillScore * 0.6 + availScore * 0.4;

  return { member, skillScore, availScore, finalScore, matchedSkills, missingSkills };
}

// ─── Auto-assignment ──────────────────────────────────────────────────────────

export interface AssignmentResult {
  taskId: string;
  taskName: string;
  assigneeId: string | null;
  assigneeName: string | null;
  startDate: string;
  endDate: string;
  score: number;
  matchedSkills: string[];
  missingSkills: string[];
  reasoning: string;
}

function addWorkingDays(fromDate: string, days: number): string {
  const d = new Date(fromDate);
  let added = 0;
  while (added < days) {
    d.setDate(d.getDate() + 1);
    if (d.getDay() !== 0 && d.getDay() !== 6) added++;
  }
  return d.toISOString().split('T')[0] + 'T00:00:00.000Z';
}

export async function suggestAssignments(
  project: PmProject,
  ownerId: string
): Promise<AssignmentResult[]> {
  const [tasks, members] = await Promise.all([
    getTasksByProject(project._id),
    getTeamMembers(ownerId),
  ]);

  if (tasks.length === 0 || members.length === 0) return [];

  // Topological sort (respects dependencies)
  const taskMap = new Map(tasks.map(t => [t._id, t]));
  const sorted = topoSort(tasks);

  // Track extra commitments added in this session (not yet in DB)
  const inSessionCommitments: Map<string, Array<{ start_date: string; end_date: string; estimated_hours: number; name: string }>> = new Map();
  members.forEach(m => inSessionCommitments.set(m._id, []));

  const results: AssignmentResult[] = [];
  const taskDates = new Map<string, { start: string; end: string }>();

  for (const task of sorted) {
    // Calculate start date: max(project.start, max dependency end_date)
    let startDate = project.start_date;
    for (const depId of task.dependencies) {
      const depDates = taskDates.get(depId);
      if (depDates && depDates.end > startDate) startDate = depDates.end;
    }

    // Score all members
    const scores: MemberScore[] = await Promise.all(
      members.map(async m => {
        const estDays = Math.ceil(task.estimated_hours / m.capacity_hours_per_day);
        const endDate = addWorkingDays(startDate, estDays);
        const avail = await calculateAvailability(
          m,
          ownerId,
          startDate,
          endDate,
          inSessionCommitments.get(m._id) ?? []
        );
        return scoreMemberForTask(m, task, avail);
      })
    );

    scores.sort((a, b) => b.finalScore - a.finalScore);
    const best = scores[0];

    const estDays = Math.ceil(task.estimated_hours / (best?.member.capacity_hours_per_day ?? 8));
    const endDate = addWorkingDays(startDate, estDays);

    taskDates.set(task._id, { start: startDate, end: endDate });

    if (best) {
      inSessionCommitments.get(best.member._id)?.push({
        start_date: startDate,
        end_date: endDate,
        estimated_hours: task.estimated_hours,
        name: task.name,
      });
    }

    const assignee = best?.member ?? null;
    const skillInfo = best
      ? `Skills: ${best.matchedSkills.length}/${task.required_skills.length} coinciden`
      : 'Sin equipo disponible';

    const reasoning = assignee
      ? `${assignee.name} — score ${(best.finalScore * 100).toFixed(0)}%. ${skillInfo}.`
      : 'No hay miembros en el equipo.';

    results.push({
      taskId: task._id,
      taskName: task.name,
      assigneeId: assignee?._id ?? null,
      assigneeName: assignee?.name ?? null,
      startDate,
      endDate,
      score: best?.finalScore ?? 0,
      matchedSkills: best?.matchedSkills ?? [],
      missingSkills: best?.missingSkills ?? [],
      reasoning,
    });
  }

  // Persist assignments to DB
  await Promise.all(
    results.map(r =>
      updatePmTask(r.taskId, {
        assignee_id: r.assigneeId,
        start_date: r.startDate,
        end_date: r.endDate,
      })
    )
  );

  return results;
}

// ─── Topological sort ─────────────────────────────────────────────────────────

function topoSort(tasks: PmTask[]): PmTask[] {
  const idToTask = new Map(tasks.map(t => [t._id, t]));
  const visited = new Set<string>();
  const result: PmTask[] = [];

  function visit(task: PmTask) {
    if (visited.has(task._id)) return;
    visited.add(task._id);
    for (const depId of task.dependencies) {
      const dep = idToTask.get(depId);
      if (dep) visit(dep);
    }
    result.push(task);
  }

  for (const task of tasks) visit(task);
  return result;
}

// ─── Gantt data ───────────────────────────────────────────────────────────────

export interface GanttData {
  project: PmProject;
  tasks: PmTask[];
  members: TeamMember[];
}

export async function getGanttData(project: PmProject, ownerId: string): Promise<GanttData> {
  const [tasks, members] = await Promise.all([
    getTasksByProject(project._id),
    getTeamMembers(ownerId),
  ]);
  return { project, tasks, members };
}

// ─── Helpers for route layer ──────────────────────────────────────────────────

export async function importTasksFromDoc(
  project: PmProject,
  userId: string,
  tokens: GoogleTokens
): Promise<PmTask[]> {
  if (!project.drive_doc_id) throw new Error('El proyecto no tiene un documento de Drive asociado.');

  const parsed = await parseDocToTasks(project.drive_doc_id, userId, tokens);

  // Delete existing tasks for this project
  await deleteTasksByProject(project._id);

  // Create new tasks (first pass: without dependencies resolved)
  const created: PmTask[] = [];
  for (const p of parsed) {
    const task = await createPmTask(project._id, userId, {
      name: p.name,
      description: p.description,
      required_skills: p.required_skills,
      estimated_hours: Math.max(1, p.estimated_hours),
      start_date: project.start_date,
      end_date: project.end_date,
      assignee_id: null,
      dependencies: [],
      status: 'pending',
    });
    created.push(task);
  }

  // Second pass: resolve dependency names to IDs
  const nameToId = new Map(created.map((t, i) => [parsed[i].name.toLowerCase(), t._id]));
  for (let i = 0; i < parsed.length; i++) {
    const depIds = parsed[i].dependencies_names
      .map(n => nameToId.get(n.toLowerCase()))
      .filter((id): id is string => !!id);
    if (depIds.length > 0) {
      await updatePmTask(created[i]._id, { dependencies: depIds });
    }
  }

  return getTasksByProject(project._id);
}
