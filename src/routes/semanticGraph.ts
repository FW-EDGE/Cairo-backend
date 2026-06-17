import { Router, Request, Response } from 'express';
import { ObjectId } from 'mongodb';
import { requireUser } from '../auth/middleware.js';
import { embeddingsCol } from '../db/client.js';

const router = Router();

const K_NEIGHBORS        = 5;
const SIMILARITY_THRESHOLD = 0.72;
const MAX_PER_SOURCE     = 200; // cap per source keeps O(n²) fast (<1 s for 400 docs)

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na  += a[i] * a[i];
    nb  += b[i] * b[i];
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d === 0 ? 0 : dot / d;
}

// GET /api/semantic-graph
// Returns nodes + edges based on pairwise embedding cosine similarity.
// Each node = one logical document (Drive file or Gmail message).
// Each edge  = top-K most similar neighbour pairs above the threshold.
router.get('/api/semantic-graph', requireUser, async (req: Request, res: Response) => {
  try {
    const uid = new ObjectId(req.user!._id);
    const col = await embeddingsCol();

    // Fetch representative chunk per Drive file (chunk_0) + all Gmail messages
    const [driveDocs, gmailDocs] = await Promise.all([
      col
        .find({ user_id: uid, source: 'drive', section: 'chunk_0' })
        .sort({ indexed_at: -1 })
        .limit(MAX_PER_SOURCE)
        .project({ file_id: 1, name: 1, url: 1, type: 1, source: 1, preview: 1, embedding: 1 })
        .toArray(),
      col
        .find({ user_id: uid, source: 'gmail' })
        .sort({ indexed_at: -1 })
        .limit(MAX_PER_SOURCE)
        .project({ message_id: 1, name: 1, url: 1, type: 1, source: 1, preview: 1, embedding: 1 })
        .toArray(),
    ]);

    // One doc per unique file/message; skip docs without embedding vectors
    const byKey = new Map<string, any>();
    for (const doc of [...driveDocs, ...gmailDocs]) {
      const key = String(doc.file_id ?? doc.message_id ?? doc._id);
      if (!byKey.has(key) && Array.isArray(doc.embedding) && doc.embedding.length > 0) {
        byKey.set(key, { ...doc, _key: key });
      }
    }

    const docs = [...byKey.values()];
    const n    = docs.length;

    if (n === 0) {
      res.json({ nodes: [], edges: [] });
      return;
    }

    // k-NN: for each doc find its K most similar neighbours (above threshold)
    const edges: Array<{ source: string; target: string; similarity: number }> = [];
    const edgeSet = new Set<string>();

    for (let i = 0; i < n; i++) {
      const candidates: Array<{ j: number; s: number }> = [];

      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        const s = cosine(docs[i].embedding, docs[j].embedding);
        if (s >= SIMILARITY_THRESHOLD) candidates.push({ j, s });
      }

      candidates.sort((a, b) => b.s - a.s);

      for (const { j, s } of candidates.slice(0, K_NEIGHBORS)) {
        // Deduplicate undirected edges
        const ek = [docs[i]._key, docs[j]._key].sort().join('\x00');
        if (!edgeSet.has(ek)) {
          edgeSet.add(ek);
          edges.push({ source: docs[i]._key, target: docs[j]._key, similarity: s });
        }
      }
    }

    const nodes = docs.map(d => ({
      id:      d._key,
      name:    d.name    ?? 'Sin nombre',
      url:     d.url     ?? '',
      type:    d.type    ?? 'file',
      source:  d.source  ?? 'drive',
      preview: d.preview ?? '',
    }));

    res.json({ nodes, edges });
  } catch (err) {
    console.error('[semantic-graph]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
