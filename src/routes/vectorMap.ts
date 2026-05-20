import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { ObjectId } from 'mongodb';
import { requireUser } from '../auth/middleware.js';
import { computeVectorMap, VectorPoint } from '../services/pca.js';
import { embeddingsCol } from '../db/client.js';

// Only cache non-empty results — empty means "not indexed yet", not worth caching
const cache = new Map<string, VectorPoint[]>();

export async function vectorMapRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /api/vector-map — full point cloud (no text)
  fastify.get('/api/vector-map', { preHandler: requireUser }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const user = request.user!;
      const query = request.query as { refresh?: string };
      const shouldRefresh = query.refresh === 'true' || query.refresh === '1';

      const cached = cache.get(user._id);
      if (cached && cached.length > 0 && !shouldRefresh) {
        console.log(`[VectorMap] Serving ${cached.length} cached points for user ${user._id}`);
        return reply.send({ points: cached, count: cached.length });
      }

      console.log(`[VectorMap] Computing vector map for user ${user._id}…`);
      const points = await computeVectorMap(user._id);
      console.log(`[VectorMap] Computed ${points.length} points for user ${user._id}`);

      if (points.length > 0) cache.set(user._id, points);

      return reply.send({ points, count: points.length });
    } catch (err) {
      console.error('[VectorMap] Error:', err);
      return reply.status(500).send({ error: 'Failed to compute vector map' });
    }
  });

  // GET /api/vector-map/detail — fetch text + metadata for a single embedding
  fastify.get('/api/vector-map/detail', { preHandler: requireUser }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const user  = request.user!;
      const query = request.query as { name?: string; url?: string; section?: string };
      const { name = '', url = '', section = '' } = query;

      const col = await embeddingsCol();
      const doc = await col.findOne(
        { user_id: new ObjectId(user._id), name, url, section },
        { projection: { name: 1, url: 1, type: 1, source: 1, section: 1, text: 1, indexed_at: 1 } }
      );

      if (!doc) return reply.status(404).send({ error: 'Embedding not found' });

      return reply.send({
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
      return reply.status(500).send({ error: 'Failed to fetch embedding detail' });
    }
  });
}
