import { Router, Request, Response } from 'express';
import { ObjectId } from 'mongodb';
import { requireUser } from '../auth/middleware.js';
import { computeVectorMap, VectorPoint } from '../services/pca.js';
import { embeddingsCol } from '../db/client.js';

const cache = new Map<string, VectorPoint[]>();
const router = Router();

// GET /api/vector-map
router.get('/api/vector-map', requireUser, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const shouldRefresh = req.query.refresh === 'true' || req.query.refresh === '1';
    const cached = cache.get(user._id);
    if (cached && cached.length > 0 && !shouldRefresh) {
      console.log(`[VectorMap] Serving ${cached.length} cached points for user ${user._id}`);
      res.json({ points: cached, count: cached.length });
      return;
    }
    console.log(`[VectorMap] Computing vector map for user ${user._id}…`);
    const points = await computeVectorMap(user._id);
    console.log(`[VectorMap] Computed ${points.length} points for user ${user._id}`);
    if (points.length > 0) cache.set(user._id, points);
    res.json({ points, count: points.length });
  } catch (err) {
    console.error('[VectorMap] Error:', err);
    res.status(500).json({ error: 'Failed to compute vector map' });
  }
});

// GET /api/vector-map/detail
router.get('/api/vector-map/detail', requireUser, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const { name = '', url = '', section = '' } = req.query as { name?: string; url?: string; section?: string };
    const col = await embeddingsCol();
    const doc = await col.findOne(
      { user_id: new ObjectId(user._id), name, url, section },
      { projection: { name: 1, url: 1, type: 1, source: 1, section: 1, text: 1, indexed_at: 1 } }
    );
    if (!doc) { res.status(404).json({ error: 'Embedding not found' }); return; }
    res.json({ name: doc.name ?? '', url: doc.url ?? '', type: doc.type ?? '', source: doc.source ?? '', section: doc.section ?? '', text: doc.text ?? '', indexed_at: doc.indexed_at ?? null });
  } catch (err) {
    console.error('[VectorMap] /detail error:', err);
    res.status(500).json({ error: 'Failed to fetch embedding detail' });
  }
});

export default router;
