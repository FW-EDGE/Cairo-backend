import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { ObjectId } from 'mongodb';
import { requireUser } from '../auth/middleware.js';
import { embeddingsCol } from '../db/client.js';
import { runFullIndex } from '../services/embeddingsIndexer.js';
import { TIER_LIMITS, Tier, PaidTier } from '../db/users.js';

export async function embeddingsRoutes(fastify: FastifyInstance): Promise<void> {
  // POST /embeddings/index
  fastify.post('/embeddings/index', { preHandler: requireUser }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const user = request.user!;

      if (user.tier === 'free') {
        return reply.status(403).send({ error: 'Semantic indexing requires a Pro or Business plan' });
      }

      if (!user.google_tokens) {
        return reply.status(403).send({ error: 'Google account not connected' });
      }

      const tier = user.tier as PaidTier;
      const limits = TIER_LIMITS[tier];

      // Start indexing in background
      setImmediate(async () => {
        try {
          const result = await runFullIndex(user._id, user.google_tokens!, tier);
          console.log(`[Embeddings] Full index complete for user ${user._id} (${tier}):`, result);
        } catch (err) {
          console.error(`[Embeddings] Full index error for user ${user._id}:`, err);
        }
      });

      return reply.send({
        ok: true,
        message: 'Indexing started in background',
        tier,
        limits,
      });
    } catch (err) {
      console.error('[Embeddings] POST /embeddings/index error:', err);
      return reply.status(500).send({ error: 'Failed to start indexing' });
    }
  });

  // GET /embeddings/status
  fastify.get('/embeddings/status', { preHandler: requireUser }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const user = request.user!;
      const col = await embeddingsCol();

      const pipeline = [
        { $match: { user_id: new ObjectId(user._id) } },
        { $group: { _id: '$source', count: { $sum: 1 } } },
      ];

      const results = await col.aggregate(pipeline).toArray();

      const counts: Record<string, number> = {};
      let total = 0;
      for (const r of results) {
        counts[r._id as string] = r.count as number;
        total += r.count as number;
      }

      const tier = (user.tier ?? 'free') as Tier;
      const limits = tier !== 'free' ? TIER_LIMITS[tier as PaidTier] : null;
      const maxTotal = limits ? limits.maxDriveEmbeddings + limits.maxEmails : 0;

      return reply.send({ counts, total, tier, limits, maxTotal });
    } catch (err) {
      console.error('[Embeddings] GET /embeddings/status error:', err);
      return reply.status(500).send({ error: 'Failed to fetch embeddings status' });
    }
  });
}
