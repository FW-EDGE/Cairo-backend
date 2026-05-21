import { Router, Request, Response } from 'express';
import { ObjectId } from 'mongodb';
import { requireUser } from '../auth/middleware.js';
import { embeddingsCol } from '../db/client.js';
import { runFullIndex } from '../services/embeddingsIndexer.js';
import { TIER_LIMITS, Tier, PaidTier } from '../db/users.js';

const router = Router();

// POST /embeddings/index
router.post('/embeddings/index', requireUser, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    if (user.tier === 'free') { res.status(403).json({ error: 'Semantic indexing requires a Pro or Business plan' }); return; }
    if (!user.google_tokens) { res.status(403).json({ error: 'Google account not connected' }); return; }

    const tier = user.tier as PaidTier;
    const limits = TIER_LIMITS[tier];

    setImmediate(async () => {
      try {
        const result = await runFullIndex(user._id, user.google_tokens!, tier);
        console.log(`[Embeddings] Full index complete for user ${user._id} (${tier}):`, result);
      } catch (err) {
        console.error(`[Embeddings] Full index error for user ${user._id}:`, err);
      }
    });

    res.json({ ok: true, message: 'Indexing started in background', tier, limits });
  } catch (err) {
    console.error('[Embeddings] POST /embeddings/index error:', err);
    res.status(500).json({ error: 'Failed to start indexing' });
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
    const tier = (user.tier ?? 'free') as Tier;
    const limits = tier !== 'free' ? TIER_LIMITS[tier as PaidTier] : null;
    const maxTotal = limits ? limits.maxDriveEmbeddings + limits.maxEmails : 0;
    res.json({ counts, total, tier, limits, maxTotal });
  } catch (err) {
    console.error('[Embeddings] GET /embeddings/status error:', err);
    res.status(500).json({ error: 'Failed to fetch embeddings status' });
  }
});

export default router;
