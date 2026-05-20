import { oauthStatesCol, usersCol, driveCacheCol, embeddingsCol } from './client.js';
import { serialize } from './users.js';

export interface OAuthStateMeta {
  flow: string;
  user_id?: string;
  [key: string]: unknown;
}

export async function saveOAuthState(state: string, meta: OAuthStateMeta): Promise<void> {
  const col = await oauthStatesCol();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

  await col.updateOne(
    { state },
    {
      $set: {
        state,
        meta,
        expires_at: expiresAt,
      },
    },
    { upsert: true }
  );
}

export async function popOAuthState(state: string): Promise<OAuthStateMeta | null> {
  const col = await oauthStatesCol();
  const doc = await col.findOneAndDelete({ state });
  if (!doc) return null;
  return serialize(doc.meta) as OAuthStateMeta;
}

export async function ensureIndexes(): Promise<void> {
  try {
    const users = await usersCol();
    await users.createIndex({ google_id: 1 }, { unique: true });
    await users.createIndex({ email: 1 }, { unique: true });

    const driveCache = await driveCacheCol();
    await driveCache.createIndex({ user_id: 1 }, { unique: true });
    await driveCache.createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 });

    const oauthStates = await oauthStatesCol();
    await oauthStates.createIndex({ state: 1 }, { unique: true });
    await oauthStates.createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 });

    const embeddings = await embeddingsCol();
    await embeddings.createIndex({ user_id: 1, source: 1 });
    await embeddings.createIndex({ user_id: 1, indexed_at: 1 });

    console.log('[MongoDB] Indexes ensured');
  } catch (err) {
    console.error('[MongoDB] Index creation error:', err);
  }
}
