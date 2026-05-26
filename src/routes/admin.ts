import { Router, Request, Response } from 'express';
import { ObjectId } from 'mongodb';
import { requireAdmin } from '../auth/middleware.js';
import { usersCol, embeddingsCol, driveCacheCol } from '../db/client.js';
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
    await col.updateOne({ _id: new ObjectId(req.params.id) }, { $set: { tier } });
    res.json({ ok: true });
  } catch (err) {
    console.error('[Admin] PATCH tier error:', err);
    res.status(500).json({ error: 'Failed to update tier' });
  }
});

/**
 * GET /admin/storage
 * Returns per-user embedding counts and estimated storage usage.
 */
router.get('/admin/storage', requireAdmin, async (_req: Request, res: Response) => {
  try {
    const col = await embeddingsCol();

    // Group by user_id + source
    const pipeline = [
      {
        $group: {
          _id: { user_id: '$user_id', source: '$source' },
          count: { $sum: 1 },
          // Rough text bytes: avg text length
          text_bytes: { $sum: { $strLenBytes: { $ifNull: ['$text', ''] } } },
        },
      },
      { $sort: { count: -1 } },
    ];

    const rows = await col.aggregate(pipeline).toArray();

    // Aggregate by user
    const byUser = new Map<string, { drive: number; gmail: number; other: number; text_bytes: number }>();
    for (const r of rows) {
      const uid = String(r._id.user_id);
      const src = String(r._id.source ?? 'other');
      if (!byUser.has(uid)) byUser.set(uid, { drive: 0, gmail: 0, other: 0, text_bytes: 0 });
      const u = byUser.get(uid)!;
      if (src === 'gmail')      u.gmail       += r.count as number;
      else if (src === 'drive') u.drive       += r.count as number;
      else                      u.other       += r.count as number;
      u.text_bytes += r.text_bytes as number;
    }

    const VECTOR_BYTES_PER_DOC = 1536 * 8; // float64
    const result = Array.from(byUser.entries()).map(([uid, v]) => {
      const total = v.drive + v.gmail + v.other;
      const vector_mb = (total * VECTOR_BYTES_PER_DOC) / 1_048_576;
      const text_mb   = v.text_bytes / 1_048_576;
      return {
        user_id:   uid,
        drive:     v.drive,
        gmail:     v.gmail,
        other:     v.other,
        total,
        vector_mb: +vector_mb.toFixed(1),
        text_mb:   +text_mb.toFixed(1),
        total_mb:  +(vector_mb + text_mb).toFixed(1),
      };
    }).sort((a, b) => b.total - a.total);

    const grand_total_mb = result.reduce((s, r) => s + r.total_mb, 0);
    res.json({ users: result, grand_total_mb: +grand_total_mb.toFixed(1) });
  } catch (err) {
    console.error('[Admin] GET /admin/storage error:', err);
    res.status(500).json({ error: 'Failed to fetch storage stats' });
  }
});

/**
 * DELETE /admin/users/:id/embeddings
 * Wipe all embeddings for a user (frees Atlas storage). Admin only.
 */
router.delete('/admin/users/:id/embeddings', requireAdmin, async (req: Request, res: Response) => {
  try {
    const col = await embeddingsCol();
    const uid = new ObjectId(req.params.id);
    const result = await col.deleteMany({ user_id: uid });
    console.log(`[Admin] Deleted ${result.deletedCount} embeddings for user ${req.params.id}`);
    res.json({ ok: true, deleted: result.deletedCount });
  } catch (err) {
    console.error('[Admin] DELETE embeddings error:', err);
    res.status(500).json({ error: 'Failed to delete embeddings' });
  }
});

/**
 * POST /admin/users/:id/deduplicate
 * Remove duplicate embeddings for a user, keeping only the most recent per file+chunk.
 * Returns the number of deleted duplicates. Admin only.
 */
router.post('/admin/users/:id/deduplicate', requireAdmin, async (req: Request, res: Response) => {
  try {
    const col = await embeddingsCol();
    const uid = new ObjectId(req.params.id);
    let deleted = 0;

    // ── Drive: deduplicate by (file_id, section) ──────────────────────────
    const driveDups = await col.aggregate([
      { $match: { user_id: uid, source: 'drive', file_id: { $exists: true, $ne: null } } },
      { $group: { _id: { file_id: '$file_id', section: '$section' }, ids: { $push: '$_id' }, count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } },
    ]).toArray();

    for (const group of driveDups) {
      const latest = await col.findOne(
        { user_id: uid, file_id: group._id.file_id, section: group._id.section },
        { sort: { indexed_at: -1 }, projection: { _id: 1 } }
      );
      if (!latest) continue;
      const r = await col.deleteMany({
        user_id: uid,
        file_id: group._id.file_id,
        section: group._id.section,
        _id: { $ne: latest._id },
      });
      deleted += r.deletedCount;
    }

    // ── Gmail: deduplicate by message_id ──────────────────────────────────
    const gmailDups = await col.aggregate([
      { $match: { user_id: uid, source: 'gmail', message_id: { $exists: true, $ne: null } } },
      { $group: { _id: '$message_id', ids: { $push: '$_id' }, count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } },
    ]).toArray();

    for (const group of gmailDups) {
      const latest = await col.findOne(
        { user_id: uid, message_id: group._id },
        { sort: { indexed_at: -1 }, projection: { _id: 1 } }
      );
      if (!latest) continue;
      const r = await col.deleteMany({
        user_id: uid,
        message_id: group._id,
        _id: { $ne: latest._id },
      });
      deleted += r.deletedCount;
    }

    console.log(`[Admin] Deduplicated user ${req.params.id}: removed ${deleted} duplicate embeddings`);
    res.json({ ok: true, deleted, drive_groups: driveDups.length, gmail_groups: gmailDups.length });
  } catch (err) {
    console.error('[Admin] POST /deduplicate error:', err);
    res.status(500).json({ error: 'Failed to deduplicate' });
  }
});

/**
 * DELETE /admin/users/:id/drive-cache
 * Wipe drive cache for a user. Admin only.
 */
router.delete('/admin/users/:id/drive-cache', requireAdmin, async (req: Request, res: Response) => {
  try {
    const col  = await driveCacheCol();
    const uid  = new ObjectId(req.params.id);
    const result = await col.deleteMany({ user_id: uid });
    console.log(`[Admin] Deleted drive cache for user ${req.params.id}`);
    res.json({ ok: true, deleted: result.deletedCount });
  } catch (err) {
    console.error('[Admin] DELETE drive-cache error:', err);
    res.status(500).json({ error: 'Failed to delete drive cache' });
  }
});

export default router;
