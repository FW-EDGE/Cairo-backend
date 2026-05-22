import { Router, Request, Response } from 'express';
import { requireAdmin } from '../auth/middleware.js';
import { usersCol } from '../db/client.js';
import { TIER_LIMITS, Tier, serialize } from '../db/users.js';

const router = Router();

const PRICE_PER_M = {
  embedding:    0.02,
  chat_input:   2.50,
  chat_output: 10.00,
};

function estimateCost(tu?: { embedding_tokens?: number; chat_input_tokens?: number; chat_output_tokens?: number }): number {
  if (!tu) return 0;
  return (
    ((tu.embedding_tokens   ?? 0) / 1_000_000) * PRICE_PER_M.embedding   +
    ((tu.chat_input_tokens  ?? 0) / 1_000_000) * PRICE_PER_M.chat_input  +
    ((tu.chat_output_tokens ?? 0) / 1_000_000) * PRICE_PER_M.chat_output
  );
}

/**
 * GET /admin/users
 * Returns all users with their consumption stats.
 * Admin tier only.
 */
router.get('/admin/users', requireAdmin, async (_req: Request, res: Response) => {
  try {
    const col = await usersCol();
    const users = await col
      .find({})
      .project({
        _id: 1, email: 1, name: 1, picture: 1, tier: 1,
        created_at: 1, last_login: 1,
        usage: 1,
        token_usage: 1,
      })
      .sort({ last_login: -1 })
      .toArray();

    const rows = users.map((u) => {
      const tier    = (u.tier ?? 'free') as Tier;
      const limits  = TIER_LIMITS[tier];
      const tu      = u.token_usage as any;
      const usage   = u.usage as any;

      // Period-aware message count
      const periodStart  = usage?.period_start ? new Date(usage.period_start) : null;
      const daysSince    = periodStart ? (Date.now() - periodStart.getTime()) / 86_400_000 : 999;
      const msgsThisMonth = daysSince >= 30 ? 0 : (usage?.chat_messages ?? 0);

      return {
        ...serialize(u),
        stats: {
          msgs_this_month:   msgsThisMonth,
          msgs_limit:        limits.chat_messages,
          embedding_tokens:  tu?.embedding_tokens   ?? 0,
          chat_input_tokens: tu?.chat_input_tokens  ?? 0,
          chat_output_tokens:tu?.chat_output_tokens ?? 0,
          estimated_cost_usd: estimateCost(tu),
        },
      };
    });

    // Aggregate totals across all users
    const totals = rows.reduce(
      (acc, r) => ({
        embedding_tokens:   acc.embedding_tokens   + r.stats.embedding_tokens,
        chat_input_tokens:  acc.chat_input_tokens  + r.stats.chat_input_tokens,
        chat_output_tokens: acc.chat_output_tokens + r.stats.chat_output_tokens,
        estimated_cost_usd: acc.estimated_cost_usd + r.stats.estimated_cost_usd,
      }),
      { embedding_tokens: 0, chat_input_tokens: 0, chat_output_tokens: 0, estimated_cost_usd: 0 }
    );

    res.json({ users: rows, totals });
  } catch (err) {
    console.error('[Admin] GET /admin/users error:', err);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

/**
 * PATCH /admin/users/:id/tier
 * Change a user's tier. Admin only.
 */
router.patch('/admin/users/:id/tier', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { tier } = req.body as { tier: string };
    if (!['free', 'pro', 'business', 'admin'].includes(tier)) {
      res.status(400).json({ error: 'Invalid tier' });
      return;
    }
    const col = await usersCol();
    const { ObjectId } = await import('mongodb');
    await col.updateOne({ _id: new ObjectId(req.params.id) }, { $set: { tier } });
    res.json({ ok: true });
  } catch (err) {
    console.error('[Admin] PATCH tier error:', err);
    res.status(500).json({ error: 'Failed to update tier' });
  }
});

export default router;
