import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { requireUser } from '../auth/middleware.js';
import { AVAILABLE_SKILLS } from '../services/skills.js';
import { toggleSkill, updateReportSettings } from '../db/users.js';

export async function skillsRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /skills
  fastify.get('/skills', { preHandler: requireUser }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const user = request.user!;
      const userSkills = user.skills || {};

      const skillsWithState = AVAILABLE_SKILLS.map((skill) => ({
        ...skill,
        enabled: userSkills[skill.id] ?? true,
        settings: skill.id === 'report_generation' ? user.reportSettings : undefined,
      }));

      console.log(`[Skills] Enviando ${skillsWithState.length} skills al usuario ${user.email}`);
      return reply.send({ skills: skillsWithState });
    } catch (err) {
      console.error('[Skills] GET /skills error:', err);
      return reply.status(500).send({ error: 'Failed to fetch skills' });
    }
  });

  // POST /skills/:skillId/toggle
  fastify.post('/skills/:skillId/toggle', { preHandler: requireUser }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const user = request.user!;
      const { skillId } = request.params as { skillId: string };
      const { enabled } = request.body as { enabled: boolean };

      if (typeof enabled !== 'boolean') {
        return reply.status(400).send({ error: 'enabled (boolean) is required' });
      }

      // Check if skill exists
      if (!AVAILABLE_SKILLS.find((s) => s.id === skillId)) {
        return reply.status(404).send({ error: 'Skill not found' });
      }

      await toggleSkill(user._id, skillId, enabled);

      return reply.send({ ok: true, skillId, enabled });
    } catch (err) {
      console.error('[Skills] POST /skills/toggle error:', err);
      return reply.status(500).send({ error: 'Failed to toggle skill' });
    }
  });

  // POST /skills/report-settings
  fastify.post('/skills/report-settings', { preHandler: requireUser }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const user = request.user!;
      const settings = request.body as { prompt?: string; templateId?: string; parentFolderId?: string };
      await updateReportSettings(user._id, settings);
      return reply.send({ success: true });
    } catch (err) {
      console.error('[Skills] POST /skills/report-settings error:', err);
      return reply.status(500).send({ error: 'Failed to update report settings' });
    }
  });
}
