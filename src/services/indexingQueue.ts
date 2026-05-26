/**
 * MongoDB-backed indexing job queue.
 *
 * Why MongoDB instead of an in-memory Set:
 *  - In-memory state is lost on every restart/deploy.
 *  - Multiple process instances (horizontal scaling) share one MongoDB cluster,
 *    so deduplication and concurrency limits are enforced globally.
 *
 * Design:
 *  - One document per pending/running job in `indexing_jobs`.
 *  - `findOneAndUpdate` is atomic — two racing workers cannot both acquire
 *    the same job.
 *  - `MAX_CONCURRENT` caps how many jobs run simultaneously across ALL instances.
 *  - Jobs stuck in "running" for > JOB_TIMEOUT_MS are assumed crashed and
 *    reset to "pending" so they can be retried.
 *  - Completed documents are auto-cleaned by a TTL index.
 */

import { ObjectId, Collection } from 'mongodb';
import { getDb, usersCol } from '../db/client.js';
import { runFullIndex } from './embeddingsIndexer.js';
import { Tier } from '../db/users.js';
import { broadcastJson } from '../websocket.js';

// ── Tunables ──────────────────────────────────────────────────────────────────
/** Max simultaneous indexing jobs across ALL process instances. */
const MAX_CONCURRENT  = 5;
/** How often the worker polls for new jobs (ms). */
const POLL_INTERVAL_MS = 5_000;
/** If a job stays "running" longer than this, assume the worker crashed. */
const JOB_TIMEOUT_MS  = 30 * 60_000; // 30 min
/** Completed/failed jobs are deleted from MongoDB after this many seconds. */
const TTL_SECONDS     = 24 * 60 * 60; // 1 day

// ── Types ─────────────────────────────────────────────────────────────────────
export type JobStatus = 'pending' | 'running' | 'done' | 'failed';

export interface IndexJob {
  _id:           ObjectId;
  user_id:       string;    // string representation of the user's ObjectId
  tier:          string;
  status:        JobStatus;
  created_at:    Date;
  started_at?:   Date;
  completed_at?: Date;      // TTL index field — document auto-deleted after TTL_SECONDS
  error?:        string;
}

// ── Collection accessor ───────────────────────────────────────────────────────
async function jobsCol(): Promise<Collection<IndexJob>> {
  const db = await getDb();
  return db.collection<IndexJob>('indexing_jobs');
}

// ── Index setup ───────────────────────────────────────────────────────────────
/**
 * Called once at startup to ensure required indexes exist.
 * Safe to call multiple times (createIndex is idempotent).
 */
export async function ensureJobIndexes(): Promise<void> {
  const col = await jobsCol();

  // Fast lookup: find pending jobs and check if a user already has a job queued.
  await col.createIndex({ user_id: 1, status: 1 });

  // Process oldest jobs first.
  await col.createIndex({ status: 1, created_at: 1 });

  // Auto-delete completed/failed documents after TTL_SECONDS.
  // MongoDB only applies TTL to documents where the indexed field exists,
  // so pending/running jobs (no completed_at) are never auto-deleted.
  await col.createIndex(
    { completed_at: 1 },
    { expireAfterSeconds: TTL_SECONDS, sparse: true }
  );

  console.log('[IndexQueue] Indexes ensured');
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Add a user to the index queue.
 *
 * If the user already has a pending or running job nothing is inserted —
 * the existing job will cover the work.
 *
 * Returns the outcome so the caller can log/respond appropriately.
 */
export async function enqueueIndex(
  userId: string,
  tier: string,
): Promise<'queued' | 'already_pending' | 'already_running'> {
  const col = await jobsCol();

  const existing = await col.findOne({
    user_id: userId,
    status: { $in: ['pending', 'running'] },
  });

  if (existing) {
    return existing.status === 'running' ? 'already_running' : 'already_pending';
  }

  await col.insertOne({
    _id:        new ObjectId(),
    user_id:    userId,
    tier,
    status:     'pending',
    created_at: new Date(),
  });

  console.log(`[IndexQueue] Enqueued job for user ${userId} (tier: ${tier})`);
  return 'queued';
}

// ── Worker ────────────────────────────────────────────────────────────────────

let _workerStarted = false;

/**
 * Start the background worker that processes indexing jobs.
 * Safe to call multiple times — only one worker loop is started per process.
 * Each process instance runs its own worker; they compete via atomic
 * findOneAndUpdate so work is never duplicated.
 */
export function startIndexWorker(): void {
  if (_workerStarted) return;
  _workerStarted = true;
  console.log('[IndexQueue] Worker started');
  _workerLoop();
}

async function _workerLoop(): Promise<void> {
  while (true) {
    try {
      await _tick();
    } catch (err) {
      console.error('[IndexQueue] Worker tick error:', err);
    }
    await new Promise<void>((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

async function _tick(): Promise<void> {
  const col = await jobsCol();

  // ── 1. Recover stale jobs ──────────────────────────────────────────────────
  // If a worker crashed mid-job the document stays "running" forever.
  // Reset any job that has been running longer than JOB_TIMEOUT_MS.
  const staleThreshold = new Date(Date.now() - JOB_TIMEOUT_MS);
  const recovered = await col.updateMany(
    { status: 'running', started_at: { $lt: staleThreshold } },
    { $set: { status: 'pending' }, $unset: { started_at: '' } },
  );
  if (recovered.modifiedCount > 0) {
    console.warn(`[IndexQueue] Recovered ${recovered.modifiedCount} stale job(s)`);
  }

  // ── 2. Check available slots ───────────────────────────────────────────────
  const runningCount = await col.countDocuments({ status: 'running' });
  const slots = MAX_CONCURRENT - runningCount;
  if (slots <= 0) return;

  // ── 3. Pick up pending jobs (oldest first, up to available slots) ──────────
  // `findOneAndUpdate` is atomic — if two instances race, only one acquires
  // each job because the filter `{ status: 'pending' }` excludes docs already
  // flipped to 'running' by a concurrent write.
  for (let i = 0; i < slots; i++) {
    const job = await col.findOneAndUpdate(
      { status: 'pending' },
      { $set: { status: 'running', started_at: new Date() } },
      { sort: { created_at: 1 }, returnDocument: 'after' },
    );
    if (!job) break; // no more pending jobs

    // Fire-and-forget: run job concurrently, don't block the poll loop.
    _runJob(job).catch((err) =>
      console.error(`[IndexQueue] Unhandled error in job ${job._id}:`, err)
    );
  }
}

async function _runJob(job: IndexJob): Promise<void> {
  const col = await jobsCol();
  console.log(`[IndexQueue] Starting job ${job._id} for user ${job.user_id}`);

  try {
    // Re-fetch the user to get fresh tokens (they may have refreshed since enqueue).
    const users = await usersCol();
    const user  = await users.findOne({ _id: new ObjectId(job.user_id) });

    if (!user?.google_tokens) {
      console.warn(`[IndexQueue] Job ${job._id}: user ${job.user_id} has no Google tokens — skipping`);
      await col.updateOne(
        { _id: job._id },
        { $set: { status: 'failed', completed_at: new Date(), error: 'No Google tokens' } },
      );
      return;
    }

    const tier   = (user.tier ?? 'free') as Tier;
    const result = await runFullIndex(job.user_id, user.google_tokens, tier);

    console.log(`[IndexQueue] Job ${job._id} complete for user ${job.user_id}:`, result);
    await col.updateOne(
      { _id: job._id },
      { $set: { status: 'done', completed_at: new Date() } },
    );
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    console.error(`[IndexQueue] Job ${job._id} failed:`, msg);
    broadcastJson({ type: 'index_progress', userId: job.user_id, status: 'error', error: msg });
    await col.updateOne(
      { _id: job._id },
      { $set: { status: 'failed', completed_at: new Date(), error: msg } },
    );
  }
}
