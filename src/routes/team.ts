import { Router, Request, Response } from 'express';
import { requireUser } from '../auth/middleware.js';
import {
  getTeamMembers,
  getTeamMemberById,
  createTeamMember,
  updateTeamMember,
  deleteTeamMember,
} from '../db/teamMembers.js';

const router = Router();

router.get('/team', requireUser, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const members = await getTeamMembers(user._id);
    res.json({ members });
  } catch (err) {
    console.error('[Team] GET /team error:', err);
    res.status(500).json({ error: 'Error al obtener el equipo' });
  }
});

router.post('/team', requireUser, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const { name, email, role, skills, capacity_hours_per_day } = req.body as {
      name: string;
      email: string;
      role: string;
      skills?: string[];
      capacity_hours_per_day?: number;
    };

    if (!name || !role) {
      res.status(400).json({ error: 'name y role son requeridos' });
      return;
    }

    const member = await createTeamMember(user._id, {
      name,
      email: email ?? '',
      role,
      skills: skills ?? [],
      capacity_hours_per_day,
    });

    res.status(201).json({ member });
  } catch (err) {
    console.error('[Team] POST /team error:', err);
    res.status(500).json({ error: 'Error al crear el miembro' });
  }
});

router.put('/team/:id', requireUser, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const { id } = req.params;
    const { name, email, role, skills, capacity_hours_per_day } = req.body;

    const updated = await updateTeamMember(id, user._id, { name, email, role, skills, capacity_hours_per_day });
    if (!updated) {
      res.status(404).json({ error: 'Miembro no encontrado' });
      return;
    }

    res.json({ member: updated });
  } catch (err) {
    console.error('[Team] PUT /team/:id error:', err);
    res.status(500).json({ error: 'Error al actualizar el miembro' });
  }
});

router.delete('/team/:id', requireUser, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const { id } = req.params;

    const deleted = await deleteTeamMember(id, user._id);
    if (!deleted) {
      res.status(404).json({ error: 'Miembro no encontrado' });
      return;
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('[Team] DELETE /team/:id error:', err);
    res.status(500).json({ error: 'Error al eliminar el miembro' });
  }
});

export default router;
