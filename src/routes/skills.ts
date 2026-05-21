import { Router, Request, Response } from 'express';
import { requireUser } from '../auth/middleware.js';
import { AVAILABLE_SKILLS } from '../services/skills.js';
import { toggleSkill, updateReportSettings } from '../db/users.js';

const router = Router();

// GET /skills
router.get('/skills', requireUser, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const userSkills = user.skills || {};
    const skillsWithState = AVAILABLE_SKILLS.map((skill) => ({
      ...skill,
      enabled: userSkills[skill.id] ?? true,
      settings: skill.id === 'report_generation' ? user.reportSettings : undefined,
    }));
    console.log(`[Skills] Enviando ${skillsWithState.length} skills al usuario ${user.email}`);
    res.json({ skills: skillsWithState });
  } catch (err) {
    console.error('[Skills] GET /skills error:', err);
    res.status(500).json({ error: 'Failed to fetch skills' });
  }
});

// POST /skills/:skillId/toggle
router.post('/skills/:skillId/toggle', requireUser, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const { skillId } = req.params;
    const { enabled } = req.body as { enabled: boolean };
    if (typeof enabled !== 'boolean') { res.status(400).json({ error: 'enabled (boolean) is required' }); return; }
    if (!AVAILABLE_SKILLS.find((s) => s.id === skillId)) { res.status(404).json({ error: 'Skill not found' }); return; }
    await toggleSkill(user._id, skillId, enabled);
    res.json({ ok: true, skillId, enabled });
  } catch (err) {
    console.error('[Skills] POST /skills/toggle error:', err);
    res.status(500).json({ error: 'Failed to toggle skill' });
  }
});

// POST /skills/report-settings
router.post('/skills/report-settings', requireUser, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const settings = req.body as { prompt?: string; templateId?: string; parentFolderId?: string };
    await updateReportSettings(user._id, settings);
    res.json({ success: true });
  } catch (err) {
    console.error('[Skills] POST /skills/report-settings error:', err);
    res.status(500).json({ error: 'Failed to update report settings' });
  }
});

export default router;
