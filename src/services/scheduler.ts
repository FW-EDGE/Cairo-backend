import cron from 'node-cron';
import { usersCol } from '../db/client.js';
import { runFullIndex } from './embeddingsIndexer.js';
import { getGoogleTokens, PaidTier } from '../db/users.js';

/**
 * Background scheduler to keep embeddings fresh.
 */
export function startScheduler() {
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
}
