import cron from 'node-cron';
import { usersCol } from '../db/client.js';
import { runFullIndex } from './embeddingsIndexer.js';
import { getGoogleTokens, PaidTier, resetAllChatUsage } from '../db/users.js';

/**
 * Ping our own /health every 14 min so Render free tier never sleeps.
 * Uses the public URL → counts as real inbound traffic for Render.
 */
function startKeepAlive(): void {
  const url = process.env.RENDER_EXTERNAL_URL
    ? `${process.env.RENDER_EXTERNAL_URL}/health`
    : null;

  if (!url) return; // only runs on Render (env var is set automatically)

  setInterval(async () => {
    try {
      await fetch(url);
      console.log('[KeepAlive] pinged', url);
    } catch (err) {
      console.error('[KeepAlive] ping failed:', err);
    }
  }, 14 * 60 * 1000); // every 14 minutes

  console.log('[KeepAlive] started — pinging', url, 'every 14 min');
}

/**
 * Background scheduler to keep embeddings fresh.
 */
export function startScheduler() {
  startKeepAlive();
  console.log('[Scheduler] Starting background tasks...');

  // Run every 12 hours
  cron.schedule('0 */12 * * *', async () => {
    console.log('[Scheduler] Starting automated full re-indexing for all users...');
    try {
      const col = await usersCol();
      const users = await col.find({ 
        tier: { $in: ['pro', 'business'] },
        google_tokens: { $exists: true } 
      }).toArray();

      for (const user of users) {
        console.log(`[Scheduler] Auto-indexing user: ${user.email} (${user._id}, tier: ${user.tier})`);
        try {
          const tokens = await getGoogleTokens(user._id.toString());
          if (tokens) {
            await runFullIndex(user._id.toString(), tokens, user.tier as PaidTier);
            console.log(`[Scheduler] Auto-index complete for ${user.email}`);
          }
        } catch (err) {
          console.error(`[Scheduler] Error indexing user ${user.email}:`, err);
        }
      }
    } catch (err) {
      console.error('[Scheduler] Error in cron job:', err);
    }
  });

  console.log('[Scheduler] Cron job scheduled (every 12 hours)');

  // Reset all users' monthly chat quotas on the 1st of each month at 00:00 UTC
  cron.schedule('0 0 1 * *', async () => {
    console.log('[Scheduler] Monthly quota reset starting…');
    try {
      await resetAllChatUsage();
      console.log('[Scheduler] Monthly quota reset complete.');
    } catch (err) {
      console.error('[Scheduler] Monthly quota reset error:', err);
    }
  });

  console.log('[Scheduler] Monthly quota reset scheduled (1st of each month)');
}
