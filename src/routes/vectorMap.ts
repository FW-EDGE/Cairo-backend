import { Router, Request, Response } from 'express';
import { ObjectId } from 'mongodb';
import { requireUser } from '../auth/middleware.js';
import { computeVectorMap, VectorPoint } from '../services/pca.js';
import { embeddingsCol } from '../db/client.js';

const router = Router();

// ── In-memory cache ───────────────────────────────────────────────────────────
// Stores the fully-computed point list per user. Computing is expensive (~5-15s
// with 10k+ embeddings), so we cache until the user explicitly refreshes.
const cache = new Map<string, VectorPoint[]>();
// Track in-flight computations so concurrent requests share one job, not N jobs.
const inFlight = new Map<string, Promise<VectorPoint[]>>();

const PAGE_SIZE_DEFAULT = 2_000;

// ── GET /api/vector-map ───────────────────────────────────────────────────────
// Supports pagination: ?page=0&size=2000
// First page triggers computation (or returns from cache immediately).
// Subsequent pages are served from cache — no recomputation.
//
// Response: { points, page, pageSize, totalPages, total, computing: false }
// While the first computation is still running (unlikely for page > 0 callers
// since the frontend waits for page 0 first):
//   { computing: true, page, total: 0 }
router.get('/api/vector-map', requireUser, async (req: Request, res: Response) => {
  try {
    const user        = req.user!;
    const uid         = user._id;
    const shouldRefresh = req.query.refresh === 'true' || req.query.refresh === '1';
    const page        = Math.max(0, parseInt(String(req.query.page  ?? '0'),  10) || 0);
    const pageSize    = Math.max(1, parseInt(String(req.query.size  ?? String(PAGE_SIZE_DEFAULT)), 10) || PAGE_SIZE_DEFAULT);

    if (shouldRefresh) {
      cache.delete(uid);
      inFlight.delete(uid);
    }

    // Return cached result immediately
    const cached = cache.get(uid);
    if (cached) {
      const slice      = cached.slice(page * pageSize, (page + 1) * pageSize);
      const totalPages = Math.ceil(cached.length / pageSize);
      console.log(`[VectorMap] Cache hit — serving page ${page}/${totalPages - 1} (${slice.length} pts) for ${uid}`);
      res.json({ points: slice, page, pageSize, totalPages, total: cached.length, computing: false });
      return;
    }

    // If no in-flight job, start one
    if (!inFlight.has(uid)) {
      console.log(`[VectorMap] Starting computation for user ${uid}…`);
      const job = computeVectorMap(uid).then((pts) => {
        if (pts.length > 0) cache.set(uid, pts);
        inFlight.delete(uid);
        console.log(`[VectorMap] Computed ${pts.length} points for user ${uid}`);
        return pts;
      }).catch((err) => {
        inFlight.delete(uid);
        throw err;
      });
      inFlight.set(uid, job);
    }

    // Only block for page 0 — subsequent pages will hit cache on retry
    if (page === 0) {
      const pts        = await inFlight.get(uid)!;
      const slice      = pts.slice(0, pageSize);
      const totalPages = Math.ceil(pts.length / pageSize);
      res.json({ points: slice, page: 0, pageSize, totalPages, total: pts.length, computing: false });
    } else {
      // Page > 0 requested before cache is ready — tell frontend to retry
      res.json({ points: [], page, pageSize, totalPages: 0, total: 0, computing: true });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[VectorMap] Error:', msg, err instanceof Error ? err.stack?.slice(0, 500) : '');
    res.status(500).json({ error: 'Failed to compute vector map', detail: msg });
  }
});

// ── GET /api/vector-map/detail ────────────────────────────────────────────────
router.get('/api/vector-map/detail', requireUser, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const { name = '', url = '', section = '' } = req.query as { name?: string; url?: string; section?: string };
    const col = await embeddingsCol();

    // When section is empty (e.g. Gmail emails have no section field), match by name+url only.
    // When section is set (Drive chunks: "chunk_0", "chunk_1"…), include it in the filter.
    const filter: Record<string, unknown> = { user_id: new ObjectId(user._id), name, url };
    if (section) filter.section = section;

    const doc = await col.findOne(
      filter,
      { projection: { name: 1, url: 1, type: 1, source: 1, section: 1, text: 1, indexed_at: 1 } }
    );
    if (!doc) { res.status(404).json({ error: 'Embedding not found' }); return; }
    res.json({
      name:       doc.name       ?? '',
      url:        doc.url        ?? '',
      type:       doc.type       ?? '',
      source:     doc.source     ?? '',
      section:    doc.section    ?? '',
      text:       doc.text       ?? '',
      indexed_at: doc.indexed_at ?? null,
    });
  } catch (err) {
    console.error('[VectorMap] /detail error:', err);
    res.status(500).json({ error: 'Failed to fetch embedding detail' });
  }
});

export default router;
