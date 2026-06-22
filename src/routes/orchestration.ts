import { Router, Request, Response } from 'express';
import { ObjectId, Collection } from 'mongodb';
import { requireUser } from '../auth/middleware.js';
import {
  orchSkillsCol, orchToolsCol, orchAgentsCol, orchProcessesCol,
  OrchSkill, OrchTool, OrchAgent, OrchProcess,
} from '../db/orchestration.js';
import { runProcess } from '../services/processRunner.js';
import { seedBuiltins } from '../services/seedBuiltins.js';

const router = Router();

// ── POST /orchestration/processes/:id/run ─────────────────────────────────────
// SSE stream — runs a process end-to-end with real tool dispatch

router.post('/orchestration/processes/:id/run', requireUser, async (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  (req.socket as any)?.setNoDelay?.(true);
  res.flushHeaders();

  const keepalive = setInterval(() => res.write(': ping\n\n'), 20_000);
  const userId    = req.user!._id.toString();
  const { input = '' } = req.body as { input?: string };

  try {
    await runProcess(res, req.params.id, input, userId);
  } catch (err: any) {
    res.write(`data: ${JSON.stringify({ type: 'error', message: err.message ?? String(err) })}\n\n`);
  } finally {
    clearInterval(keepalive);
    res.end();
  }
});

// ── GET /orchestration ─────────────────────────────────────────────────────────
// Devuelve todos los nodos custom del usuario para hidratar el grafo

router.get('/orchestration', requireUser, async (req: Request, res: Response) => {
  try {
    const userId = new ObjectId(req.user!._id.toString());

    // Seed built-in skills/tools/agents on first access (idempotent)
    await seedBuiltins(userId).catch(err =>
      console.error('[Orchestration] seedBuiltins error:', err),
    );

    const [skillsCol, toolsCol, agentsCol, procsCol] = await Promise.all([
      orchSkillsCol(),
      orchToolsCol(),
      orchAgentsCol(),
      orchProcessesCol(),
    ]);

    const [skills, tools, agents, processes] = await Promise.all([
      skillsCol.find({ user_id: userId }).sort({ created_at: 1 }).toArray(),
      toolsCol.find({ user_id: userId }).sort({ created_at: 1 }).toArray(),
      agentsCol.find({ user_id: userId }).sort({ created_at: 1 }).toArray(),
      procsCol.find({ user_id: userId }).sort({ created_at: 1 }).toArray(),
    ]);

    res.json({ skills, tools, agents, processes });
  } catch (err: any) {
    console.error('[Orchestration] GET /orchestration error:', err);
    res.status(500).json({ error: 'Failed to fetch orchestration data', detail: err?.message ?? String(err) });
  }
});

// ── SKILLS ────────────────────────────────────────────────────────────────────

router.post('/orchestration/skills', requireUser, async (req: Request, res: Response) => {
  try {
    const userId = new ObjectId(req.user!._id.toString());
    const body = req.body as Omit<OrchSkill, '_id' | 'user_id' | 'created_at' | 'updated_at'>;

    if (!body.label?.trim())    { res.status(400).json({ error: 'label is required' });    return; }
    if (!body.skill_id?.trim()) { res.status(400).json({ error: 'skill_id is required' }); return; }

    const col = await orchSkillsCol();
    const now = new Date();
    const doc: OrchSkill = {
      label:      body.label.trim(),
      skill_id:   body.skill_id.trim(),
      description: body.description ?? '',
      prompt:     body.prompt ?? '',
      provider:   body.provider ?? 'Custom',
      auth_type:  body.auth_type ?? 'None',
      skill_type: body.skill_type ?? 'REST API',
      endpoint:   body.endpoint ?? '',
      rate_limit: body.rate_limit ?? '',
      tool_ids:   body.tool_ids ?? [],
      color:      body.color ?? '#f472b6',
      notes:      body.notes ?? '',
      is_enabled: body.is_enabled ?? true,
      user_id:    userId,
      created_at: now,
      updated_at: now,
    };

    const result = await col.insertOne(doc);
    console.log(`[Orchestration] Skill created: ${doc.skill_id} by ${req.user!.email}`);
    res.status(201).json({ ...doc, _id: result.insertedId });
  } catch (err: any) {
    if (err?.code === 11000) {
      res.status(409).json({ error: 'Ya existe un skill con ese skill_id' });
      return;
    }
    console.error('[Orchestration] POST /orchestration/skills error:', err);
    res.status(500).json({ error: 'Failed to create skill' });
  }
});

router.put('/orchestration/skills/:id', requireUser, async (req: Request, res: Response) => {
  try {
    const userId = new ObjectId(req.user!._id.toString());
    const _id    = new ObjectId(req.params.id);
    const updates = { ...req.body } as Partial<OrchSkill>;

    // Campos no actualizables
    delete (updates as any)._id;
    delete (updates as any).user_id;
    delete (updates as any).created_at;

    const col    = await orchSkillsCol();
    const result = await col.findOneAndUpdate(
      { _id, user_id: userId },
      { $set: { ...updates, updated_at: new Date() } },
      { returnDocument: 'after' },
    );

    if (!result) { res.status(404).json({ error: 'Skill not found' }); return; }
    res.json(result);
  } catch (err) {
    console.error('[Orchestration] PUT /orchestration/skills error:', err);
    res.status(500).json({ error: 'Failed to update skill' });
  }
});

router.delete('/orchestration/skills/:id', requireUser, async (req: Request, res: Response) => {
  try {
    const userId = new ObjectId(req.user!._id.toString());
    const _id    = new ObjectId(req.params.id);
    const col    = await orchSkillsCol();
    const result = await col.deleteOne({ _id, user_id: userId });

    if (result.deletedCount === 0) { res.status(404).json({ error: 'Skill not found' }); return; }
    res.json({ ok: true });
  } catch (err) {
    console.error('[Orchestration] DELETE /orchestration/skills error:', err);
    res.status(500).json({ error: 'Failed to delete skill' });
  }
});

// ── TOOLS ──────────────────────────────────────────────────────────────────────

router.post('/orchestration/tools', requireUser, async (req: Request, res: Response) => {
  try {
    const userId = new ObjectId(req.user!._id.toString());
    const body = req.body as Omit<OrchTool, '_id' | 'user_id' | 'created_at' | 'updated_at'>;

    if (!body.label?.trim())   { res.status(400).json({ error: 'label is required' });   return; }
    if (!body.tool_id?.trim()) { res.status(400).json({ error: 'tool_id is required' }); return; }

    const col = await orchToolsCol();
    const now = new Date();
    const doc: OrchTool = {
      label:       body.label.trim(),
      tool_id:     body.tool_id.trim(),
      fn:          body.fn ?? body.label.trim().toLowerCase().replace(/\s+/g, '_'),
      description: body.description ?? '',
      category:    body.category ?? 'Custom',
      skill_id:    body.skill_id ?? '',
      color:       body.color ?? '#4ade80',
      inputs:      body.inputs ?? [],
      output:      body.output ?? '',
      endpoint:    body.endpoint ?? '',
      auth_type:   body.auth_type ?? 'none',
      rate_limit:  body.rate_limit ?? '',
      timeout_ms:  body.timeout_ms ?? '',
      notes:       body.notes ?? '',
      user_id:     userId,
      created_at:  now,
      updated_at:  now,
    };

    const result = await col.insertOne(doc);
    console.log(`[Orchestration] Tool created: ${doc.tool_id} by ${req.user!.email}`);
    res.status(201).json({ ...doc, _id: result.insertedId });
  } catch (err: any) {
    if (err?.code === 11000) {
      res.status(409).json({ error: 'Ya existe una tool con ese tool_id' });
      return;
    }
    console.error('[Orchestration] POST /orchestration/tools error:', err);
    res.status(500).json({ error: 'Failed to create tool' });
  }
});

router.put('/orchestration/tools/:id', requireUser, async (req: Request, res: Response) => {
  try {
    const userId = new ObjectId(req.user!._id.toString());
    const _id    = new ObjectId(req.params.id);
    const updates = { ...req.body } as Partial<OrchTool>;
    delete (updates as any)._id;
    delete (updates as any).user_id;
    delete (updates as any).created_at;

    const col    = await orchToolsCol();
    const result = await col.findOneAndUpdate(
      { _id, user_id: userId },
      { $set: { ...updates, updated_at: new Date() } },
      { returnDocument: 'after' },
    );

    if (!result) { res.status(404).json({ error: 'Tool not found' }); return; }
    res.json(result);
  } catch (err) {
    console.error('[Orchestration] PUT /orchestration/tools error:', err);
    res.status(500).json({ error: 'Failed to update tool' });
  }
});

router.delete('/orchestration/tools/:id', requireUser, async (req: Request, res: Response) => {
  try {
    const userId = new ObjectId(req.user!._id.toString());
    const _id    = new ObjectId(req.params.id);
    const col    = await orchToolsCol();
    const result = await col.deleteOne({ _id, user_id: userId });

    if (result.deletedCount === 0) { res.status(404).json({ error: 'Tool not found' }); return; }
    res.json({ ok: true });
  } catch (err) {
    console.error('[Orchestration] DELETE /orchestration/tools error:', err);
    res.status(500).json({ error: 'Failed to delete tool' });
  }
});

// ── AGENTS ─────────────────────────────────────────────────────────────────────

router.post('/orchestration/agents', requireUser, async (req: Request, res: Response) => {
  try {
    const userId = new ObjectId(req.user!._id.toString());
    const body = req.body as Omit<OrchAgent, '_id' | 'user_id' | 'created_at' | 'updated_at'>;

    if (!body.label?.trim())    { res.status(400).json({ error: 'label is required' });    return; }
    if (!body.agent_id?.trim()) { res.status(400).json({ error: 'agent_id is required' }); return; }

    const col = await orchAgentsCol();
    const now = new Date();
    const doc: OrchAgent = {
      label:         body.label.trim(),
      agent_id:      body.agent_id.trim(),
      description:   body.description ?? '',
      system_prompt: body.system_prompt ?? '',
      skill_ids:     body.skill_ids ?? [],
      process_ids:   body.process_ids ?? [],
      color:         body.color ?? '#22d3ee',
      model:         body.model ?? 'gpt-4o-mini',
      is_enabled:    body.is_enabled ?? true,
      user_id:       userId,
      created_at:    now,
      updated_at:    now,
    };

    const result = await col.insertOne(doc);
    console.log(`[Orchestration] Agent created: ${doc.agent_id} by ${req.user!.email}`);
    res.status(201).json({ ...doc, _id: result.insertedId });
  } catch (err: any) {
    if (err?.code === 11000) {
      res.status(409).json({ error: 'Ya existe un agente con ese agent_id' });
      return;
    }
    console.error('[Orchestration] POST /orchestration/agents error:', err);
    res.status(500).json({ error: 'Failed to create agent' });
  }
});

router.put('/orchestration/agents/:id', requireUser, async (req: Request, res: Response) => {
  try {
    const userId = new ObjectId(req.user!._id.toString());
    const _id    = new ObjectId(req.params.id);
    const updates = { ...req.body } as Partial<OrchAgent>;
    delete (updates as any)._id;
    delete (updates as any).user_id;
    delete (updates as any).created_at;

    const col    = await orchAgentsCol();
    const result = await col.findOneAndUpdate(
      { _id, user_id: userId },
      { $set: { ...updates, updated_at: new Date() } },
      { returnDocument: 'after' },
    );

    if (!result) { res.status(404).json({ error: 'Agent not found' }); return; }
    res.json(result);
  } catch (err) {
    console.error('[Orchestration] PUT /orchestration/agents error:', err);
    res.status(500).json({ error: 'Failed to update agent' });
  }
});

router.delete('/orchestration/agents/:id', requireUser, async (req: Request, res: Response) => {
  try {
    const userId = new ObjectId(req.user!._id.toString());
    const _id    = new ObjectId(req.params.id);
    const col    = await orchAgentsCol();
    const result = await col.deleteOne({ _id, user_id: userId });

    if (result.deletedCount === 0) { res.status(404).json({ error: 'Agent not found' }); return; }
    res.json({ ok: true });
  } catch (err) {
    console.error('[Orchestration] DELETE /orchestration/agents error:', err);
    res.status(500).json({ error: 'Failed to delete agent' });
  }
});

// ── PROCESSES ──────────────────────────────────────────────────────────────────

router.post('/orchestration/processes', requireUser, async (req: Request, res: Response) => {
  try {
    const userId = new ObjectId(req.user!._id.toString());
    const body = req.body as Omit<OrchProcess, '_id' | 'user_id' | 'created_at' | 'updated_at'>;

    if (!body.label?.trim())      { res.status(400).json({ error: 'label is required' });      return; }
    if (!body.process_id?.trim()) { res.status(400).json({ error: 'process_id is required' }); return; }

    const col = await orchProcessesCol();
    const now = new Date();
    const doc: OrchProcess = {
      label:      body.label.trim(),
      process_id: body.process_id.trim(),
      description: body.description ?? '',
      prompt:     body.prompt ?? '',
      command:    (body.command ?? '').trim(),
      agent_ids:  body.agent_ids ?? [],
      mode:       body.mode ?? 'sequential',
      color:      body.color ?? '#fb923c',
      notes:      body.notes ?? '',
      is_enabled: body.is_enabled ?? true,
      user_id:    userId,
      created_at: now,
      updated_at: now,
    };

    const result = await col.insertOne(doc);
    console.log(`[Orchestration] Process created: ${doc.process_id} by ${req.user!.email}`);
    res.status(201).json({ ...doc, _id: result.insertedId });
  } catch (err: any) {
    if (err?.code === 11000) {
      res.status(409).json({ error: 'Ya existe un proceso con ese process_id' });
      return;
    }
    console.error('[Orchestration] POST /orchestration/processes error:', err);
    res.status(500).json({ error: 'Failed to create process' });
  }
});

router.put('/orchestration/processes/:id', requireUser, async (req: Request, res: Response) => {
  try {
    const userId = new ObjectId(req.user!._id.toString());
    const _id    = new ObjectId(req.params.id);
    const updates = { ...req.body } as Partial<OrchProcess>;
    delete (updates as any)._id;
    delete (updates as any).user_id;
    delete (updates as any).created_at;

    const col    = await orchProcessesCol();
    const result = await col.findOneAndUpdate(
      { _id, user_id: userId },
      { $set: { ...updates, updated_at: new Date() } },
      { returnDocument: 'after' },
    );

    if (!result) { res.status(404).json({ error: 'Process not found' }); return; }
    res.json(result);
  } catch (err) {
    console.error('[Orchestration] PUT /orchestration/processes error:', err);
    res.status(500).json({ error: 'Failed to update process' });
  }
});

router.delete('/orchestration/processes/:id', requireUser, async (req: Request, res: Response) => {
  try {
    const userId = new ObjectId(req.user!._id.toString());
    const _id    = new ObjectId(req.params.id);
    const col    = await orchProcessesCol();
    const result = await col.deleteOne({ _id, user_id: userId });

    if (result.deletedCount === 0) { res.status(404).json({ error: 'Process not found' }); return; }
    res.json({ ok: true });
  } catch (err) {
    console.error('[Orchestration] DELETE /orchestration/processes error:', err);
    res.status(500).json({ error: 'Failed to delete process' });
  }
});

export default router;
