import { Router, Request, Response } from 'express';
import { ObjectId } from 'mongodb';
import { requireUser } from '../auth/middleware.js';
import { embeddingsCol } from '../db/client.js';
import { TIER_LIMITS, Tier } from '../db/users.js';
import { enqueueIndex } from '../services/indexingQueue.js';

const router = Router();

// POST /embeddings/index
// Adds the user to the shared MongoDB job queue.
// The worker (started at server boot) picks it up respecting MAX_CONCURRENT.
// Returns immediately — progress is broadcast via WebSocket.
router.post('/embeddings/index', requireUser, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    if (!user.google_tokens) { res.status(403).json({ error: 'Google account not connected' }); return; }

    const tier   = (user.tier ?? 'free') as Tier;
    const limits = TIER_LIMITS[tier];

    const outcome = await enqueueIndex(user._id, tier);

    res.json({
      ok:              true,
      message:         outcome === 'queued' ? 'Indexing queued' : 'Indexing already in progress',
      already_running: outcome !== 'queued',
      outcome,
      tier,
      limits,
    });
  } catch (err) {
    console.error('[Embeddings] POST /embeddings/index error:', err);
    res.status(500).json({ error: 'Failed to queue indexing' });
  }
});

// GET /embeddings/status
router.get('/embeddings/status', requireUser, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const col = await embeddingsCol();
    const pipeline = [
      { $match: { user_id: new ObjectId(user._id) } },
      { $group: { _id: '$source', count: { $sum: 1 } } },
    ];
    const results = await col.aggregate(pipeline).toArray();
    const counts: Record<string, number> = {};
    let total = 0;
    for (const r of results) { counts[r._id as string] = r.count as number; total += r.count as number; }
    const tier   = (user.tier ?? 'free') as Tier;
    const limits = TIER_LIMITS[tier];
    const maxTotal = limits.maxDriveEmbeddings + limits.maxEmails;
    res.json({ counts, total, tier, limits, maxTotal, usage: user.usage ?? null, token_usage: user.token_usage ?? null });
  } catch (err) {
    console.error('[Embeddings] GET /embeddings/status error:', err);
    res.status(500).json({ error: 'Failed to fetch embeddings status' });
  }
});

export default router;
