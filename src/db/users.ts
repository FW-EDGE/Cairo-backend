import { ObjectId } from 'mongodb';
import { usersCol } from './client.js';

// ─── Tier limits ────────────────────────────────────────────────────────────
export const TIER_LIMITS = {
  free:     { maxDriveEmbeddings: 0,       maxEmails: 50,    chat_messages: 20   },
  pro:      { maxDriveEmbeddings: 20_000,  maxEmails: 500,   chat_messages: 300  },
  business: { maxDriveEmbeddings: 150_000, maxEmails: 5_000, chat_messages: 2000 },
} as const;

export type Tier = keyof typeof TIER_LIMITS;
export type PaidTier = 'pro' | 'business';
// ─────────────────────────────────────────────────────────────────────────────

export interface GoogleTokens {
  access_token: string;
  refresh_token?: string;
  expiry?: string;
  scopes: string[];
}

export interface ChatUsage {
  chat_messages: number;
  period_start: string; // ISO — start of current 30-day period
}

export interface AppUser {
  _id: string;
  google_id: string | null;
  email: string;
  name: string;
  picture: string;
  password_hash?: string;
  google_tokens?: GoogleTokens;
  tier: 'free' | 'pro' | 'business';
  usage?: ChatUsage;
  created_at: string;
  last_login: string;
  onboarding_completed: boolean;
  integrations: {
    gmail?: { connected: boolean; last_sync?: string };
    drive?: { connected: boolean; last_sync?: string };
    calendar?: { connected: boolean; last_sync?: string };
  };
  skills?: { [skillId: string]: boolean };
  reportSettings?: {
    prompt?: string;
    templateId?: string;
    parentFolderId?: string;
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function serialize(doc: any): any {
  if (doc === null || doc === undefined) return doc;
  if (doc instanceof ObjectId) return doc.toHexString();
  if (doc instanceof Date) return doc.toISOString();
  if (Array.isArray(doc)) return doc.map(serialize);
  if (typeof doc === 'object') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out: any = {};
    for (const [k, v] of Object.entries(doc)) {
      out[k] = serialize(v);
    }
    return out;
  }
  return doc;
}

export async function upsertGoogleUser(
  googleId: string,
  email: string,
  name: string,
  picture: string,
  tokens: GoogleTokens
): Promise<AppUser> {
  const col = await usersCol();
  const now = new Date().toISOString();

  const result = await col.findOneAndUpdate(
    { google_id: googleId },
    {
      $set: {
        email,
        name,
        picture,
        google_tokens: tokens,
        last_login: now,
      },
      $setOnInsert: {
        google_id: googleId,
        tier: 'free',
        created_at: now,
        onboarding_completed: false,
        integrations: {
          gmail: { connected: false },
          drive: { connected: false },
          calendar: { connected: false },
        },
        skills: {
          jira_integration: false,
          taqtic_management: false,
          data_analysis_pro: false,
          deep_research: false,
          voice_interaction: false,
        },
        reportSettings: {
          prompt: '',
          templateId: '',
          parentFolderId: '',
        },
      },
    },
    { upsert: true, returnDocument: 'after' }
  );

  return serialize(result) as AppUser;
}

export async function getUserById(id: string): Promise<AppUser | null> {
  const col = await usersCol();
  let oid: ObjectId;
  try {
    oid = new ObjectId(id);
  } catch {
    return null;
  }
  const doc = await col.findOne({ _id: oid });
  if (!doc) return null;
  return serialize(doc) as AppUser;
}

export async function getUserByGoogleId(googleId: string): Promise<AppUser | null> {
  const col = await usersCol();
  const doc = await col.findOne({ google_id: googleId });
  if (!doc) return null;
  return serialize(doc) as AppUser;
}

/**
 * Attach a password to an existing Google-only account (no password_hash yet).
 * Throws if the account doesn't exist, already has a password, or isn't a Google account.
 */
export async function attachPasswordToGoogleUser(
  email: string,
  passwordHash: string
): Promise<AppUser> {
  const col = await usersCol();
  const existing = await col.findOne({ email });
  if (!existing) throw new Error('no_account');
  if (existing.password_hash) throw new Error('already_has_password');
  if (!existing.google_id) throw new Error('not_google_account');

  const result = await col.findOneAndUpdate(
    { email },
    { $set: { password_hash: passwordHash } },
    { returnDocument: 'after' }
  );
  return serialize(result) as AppUser;
}

export async function createEmailUser(
  email: string,
  name: string,
  passwordHash: string
): Promise<AppUser> {
  const col = await usersCol();
  const now = new Date().toISOString();

  const existing = await col.findOne({ email });
  if (existing) {
    throw new Error('User with this email already exists');
  }

  const doc = {
    google_id: null,
    email,
    name,
    picture: '',
    password_hash: passwordHash,
    tier: 'free' as const,
    created_at: now,
    last_login: now,
    onboarding_completed: false,
    integrations: {
      gmail: { connected: false },
      drive: { connected: false },
      calendar: { connected: false },
    },
    skills: {
      jira_integration: false,
      taqtic_management: false,
      data_analysis_pro: false,
      deep_research: false,
      voice_interaction: false,
    },
    reportSettings: {
      prompt: '',
      templateId: '',
      parentFolderId: '',
    },
  };

  const result = await col.insertOne(doc);
  return serialize({ ...doc, _id: result.insertedId }) as AppUser;
}

export async function getUserByEmail(email: string): Promise<AppUser | null> {
  const col = await usersCol();
  const doc = await col.findOne({ email });
  if (!doc) return null;
  return serialize(doc) as AppUser;
}

export async function markOnboardingComplete(userId: string): Promise<void> {
  const col = await usersCol();
  await col.updateOne(
    { _id: new ObjectId(userId) },
    { $set: { onboarding_completed: true } }
  );
}

export async function setUserTier(userId: string, tier: 'free' | 'pro' | 'business'): Promise<void> {
  const col = await usersCol();
  await col.updateOne(
    { _id: new ObjectId(userId) },
    { $set: { tier } }
  );
}

export async function updateReportSettings(
  userId: string,
  settings: { prompt?: string; templateId?: string; parentFolderId?: string }
): Promise<void> {
  const col = await usersCol();
  await col.updateOne(
    { _id: new ObjectId(userId) },
    { $set: { reportSettings: settings } }
  );
}

export async function updateGoogleTokens(userId: string, tokens: Partial<GoogleTokens>): Promise<void> {
  const col = await usersCol();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const setFields: any = {};
  if (tokens.access_token) setFields['google_tokens.access_token'] = tokens.access_token;
  if (tokens.refresh_token) setFields['google_tokens.refresh_token'] = tokens.refresh_token;
  if (tokens.expiry) setFields['google_tokens.expiry'] = tokens.expiry;
  if (tokens.scopes) setFields['google_tokens.scopes'] = tokens.scopes;

  await col.updateOne(
    { _id: new ObjectId(userId) },
    { $set: setFields }
  );
}

export async function getGoogleTokens(userId: string): Promise<GoogleTokens | null> {
  const col = await usersCol();
  const user = await col.findOne(
    { _id: new ObjectId(userId) },
    { projection: { google_tokens: 1 } }
  );
  return user?.google_tokens || null;
}

export async function connectGoogleUser(
  userId: string,
  tokens: GoogleTokens,
  googleId?: string,
  picture?: string
): Promise<AppUser> {
  const col = await usersCol();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const setFields: any = {
    google_tokens: tokens,
    'integrations.drive.connected': true,
    'integrations.gmail.connected': true,
    'integrations.calendar.connected': true,
  };
  if (googleId) setFields.google_id = googleId;
  if (picture) setFields.picture = picture;

  const result = await col.findOneAndUpdate(
    { _id: new ObjectId(userId) },
    { $set: setFields },
    { returnDocument: 'after' }
  );

  if (!result) throw new Error('User not found');
  return serialize(result) as AppUser;
}

export async function toggleSkill(userId: string, skillId: string, enabled: boolean): Promise<void> {
  const col = await usersCol();
  await col.updateOne(
    { _id: new ObjectId(userId) },
    { $set: { [`skills.${skillId}`]: enabled } }
  );
}

/**
 * Atomically increment chat_messages counter for the user.
 * If usage doesn't exist yet, initialise it first.
 * Returns the new count after increment.
 */
export async function incrementChatUsage(userId: string): Promise<number> {
  const col = await usersCol();
  const result = await col.findOneAndUpdate(
    { _id: new ObjectId(userId) },
    {
      $inc: { 'usage.chat_messages': 1 },
      $setOnInsert: { 'usage.period_start': new Date().toISOString() },
    },
    { returnDocument: 'after', upsert: false }
  );
  // Ensure period_start exists (first-time users won't have it)
  if (result && !result.usage?.period_start) {
    await col.updateOne(
      { _id: new ObjectId(userId) },
      { $set: { 'usage.period_start': new Date().toISOString() } }
    );
  }
  return result?.usage?.chat_messages ?? 1;
}

/**
 * Reset monthly quota counters for all users (called by the monthly cron job).
 */
export async function resetAllChatUsage(): Promise<void> {
  const col = await usersCol();
  await col.updateMany(
    {},
    { $set: { 'usage.chat_messages': 0, 'usage.period_start': new Date().toISOString() } }
  );
}
