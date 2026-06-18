import { Router, Request, Response } from 'express';
import { requireUser } from '../auth/middleware.js';
import {
  getPmProjects,
  getPmProject,
  createPmProject,
  updatePmProject,
  deletePmProject,
} from '../db/pmProjects.js';
import { createPmTask, updatePmTask, deletePmTask, getPmTask, getTasksByProject, deleteTasksByProject } from '../db/pmTasks.js';
import { importTasksFromDoc, suggestAssignments, getGanttData } from '../services/pmService.js';

const router = Router();

// ─── Projects ─────────────────────────────────────────────────────────────────

router.get('/pm/projects', requireUser, async (req: Request, res: Response) => {
  try {
    const projects = await getPmProjects(req.user!._id);
    res.json({ projects });
  } catch (err) {
    console.error('[PM] GET /pm/projects error:', err);
    res.status(500).json({ error: 'Error al obtener proyectos' });
  }
});

router.post('/pm/projects', requireUser, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const { name, drive_doc_id, drive_doc_name, status, start_date, end_date } = req.body;

    if (!name || !start_date || !end_date) {
      res.status(400).json({ error: 'name, start_date y end_date son requeridos' });
      return;
    }

    const project = await createPmProject(user._id, {
      name,
      drive_doc_id: drive_doc_id ?? null,
      drive_doc_name: drive_doc_name ?? null,
      status,
      start_date,
      end_date,
    });

    res.status(201).json({ project });
  } catch (err) {
    console.error('[PM] POST /pm/projects error:', err);
    res.status(500).json({ error: 'Error al crear proyecto' });
  }
});

router.put('/pm/projects/:id', requireUser, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const { name, drive_doc_id, drive_doc_name, status, start_date, end_date } = req.body;

    const updated = await updatePmProject(req.params.id, user._id, {
      name, drive_doc_id, drive_doc_name, status, start_date, end_date,
    });

    if (!updated) { res.status(404).json({ error: 'Proyecto no encontrado' }); return; }
    res.json({ project: updated });
  } catch (err) {
    console.error('[PM] PUT /pm/projects/:id error:', err);
    res.status(500).json({ error: 'Error al actualizar proyecto' });
  }
});

router.delete('/pm/projects/:id', requireUser, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const deleted = await deletePmProject(req.params.id, user._id);
    if (!deleted) { res.status(404).json({ error: 'Proyecto no encontrado' }); return; }
    await deleteTasksByProject(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    console.error('[PM] DELETE /pm/projects/:id error:', err);
    res.status(500).json({ error: 'Error al eliminar proyecto' });
  }
});

// ─── Parse doc → tasks ────────────────────────────────────────────────────────

router.post('/pm/projects/:id/parse', requireUser, async (req: Request, res: Response) => {
  try {
    const user = req.user!;

    if (!user.google_tokens) {
      res.status(403).json({ error: 'Google account no conectada' });
      return;
    }

    const project = await getPmProject(req.params.id, user._id);
    if (!project) { res.status(404).json({ error: 'Proyecto no encontrado' }); return; }
    if (!project.drive_doc_id) {
      res.status(400).json({ error: 'El proyecto no tiene un documento de Drive asociado' });
      return;
    }

    const tasks = await importTasksFromDoc(project, user._id, user.google_tokens);
    res.json({ tasks, count: tasks.length });
  } catch (err) {
    console.error('[PM] POST /pm/projects/:id/parse error:', err);
    res.status(500).json({ error: 'Error al analizar el documento' });
  }
});

// ─── Auto-assign ──────────────────────────────────────────────────────────────

router.post('/pm/projects/:id/assign', requireUser, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const project = await getPmProject(req.params.id, user._id);
    if (!project) { res.status(404).json({ error: 'Proyecto no encontrado' }); return; }

    const assignments = await suggestAssignments(project, user._id);
    res.json({ assignments });
  } catch (err) {
    console.error('[PM] POST /pm/projects/:id/assign error:', err);
    res.status(500).json({ error: 'Error al asignar recursos' });
  }
});

// ─── Gantt data ───────────────────────────────────────────────────────────────

router.get('/pm/projects/:id/gantt', requireUser, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const project = await getPmProject(req.params.id, user._id);
    if (!project) { res.status(404).json({ error: 'Proyecto no encontrado' }); return; }

    const data = await getGanttData(project, user._id);
    res.json(data);
  } catch (err) {
    console.error('[PM] GET /pm/projects/:id/gantt error:', err);
    res.status(500).json({ error: 'Error al obtener datos del Gantt' });
  }
});

// ─── Tasks ────────────────────────────────────────────────────────────────────

router.post('/pm/tasks', requireUser, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const { project_id, name, description, required_skills, estimated_hours, start_date, end_date, assignee_id, dependencies, status } = req.body;

    if (!project_id || !name) {
      res.status(400).json({ error: 'project_id y name son requeridos' });
      return;
    }

    const project = await getPmProject(project_id, user._id);
    if (!project) { res.status(404).json({ error: 'Proyecto no encontrado' }); return; }

    const task = await createPmTask(project_id, user._id, {
      name, description, required_skills, estimated_hours, start_date, end_date, assignee_id, dependencies, status,
    });

    res.status(201).json({ task });
  } catch (err) {
    console.error('[PM] POST /pm/tasks error:', err);
    res.status(500).json({ error: 'Error al crear la tarea' });
  }
});

router.put('/pm/tasks/:id', requireUser, async (req: Request, res: Response) => {
  try {
    const { name, description, required_skills, estimated_hours, start_date, end_date, assignee_id, dependencies, status } = req.body;

    const updated = await updatePmTask(req.params.id, {
      name, description, required_skills, estimated_hours, start_date, end_date, assignee_id, dependencies, status,
    });

    if (!updated) { res.status(404).json({ error: 'Tarea no encontrada' }); return; }
    res.json({ task: updated });
  } catch (err) {
    console.error('[PM] PUT /pm/tasks/:id error:', err);
    res.status(500).json({ error: 'Error al actualizar la tarea' });
  }
});

router.delete('/pm/tasks/:id', requireUser, async (req: Request, res: Response) => {
  try {
    const deleted = await deletePmTask(req.params.id);
    if (!deleted) { res.status(404).json({ error: 'Tarea no encontrada' }); return; }
    res.json({ ok: true });
  } catch (err) {
    console.error('[PM] DELETE /pm/tasks/:id error:', err);
    res.status(500).json({ error: 'Error al eliminar la tarea' });
  }
});

export default router;
