import { OAuth2Client, Credentials } from 'google-auth-library';
import { randomBytes } from 'crypto';
import { getConfig } from '../config.js';
import { GoogleTokens, updateGoogleTokens } from '../db/users.js';

// Core scopes — requested at login (Sensitive, standard Google verification)
export const SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar.readonly',  // read calendar list + events (for /calendar/week)
  'https://www.googleapis.com/auth/calendar.events',   // create/edit events
  'https://www.googleapis.com/auth/contacts.readonly',  // search contacts by name
];

// Extended scopes — requested only when user enables report generation (incremental auth)
export const REPORT_SCOPES = [
  ...SCOPES,
  'https://www.googleapis.com/auth/drive.file', // create/edit files owned by this app
];

export function createOAuth2Client(): OAuth2Client {
  const config = getConfig();
  const client = new OAuth2Client(
    config.auth.google_client_id,
    config.auth.google_client_secret,
    config.auth.redirect_uri
  );
  // Render free tier drops gzip streams mid-transfer causing ERR_STREAM_PREMATURE_CLOSE on
  // both API calls and OAuth token refresh. Forcing identity encoding removes the Gunzip step.
  try {
    const t = (client as any).transporter;
    if (t) {
      t.defaults = { ...(t.defaults ?? {}), headers: { 'Accept-Encoding': 'identity' } };
    }
  } catch { /* ignore — transporter shape may vary across google-auth-library versions */ }
  return client;
}

export function getAuthUrl(client: OAuth2Client): { url: string; state: string } {
  const state = randomBytes(32).toString('hex');
  const url = client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
    state,
  });
  return { url, state };
}

export async function exchangeCode(
  code: string
): Promise<{ client: OAuth2Client; tokens: Credentials }> {
  const client = createOAuth2Client();
  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);
  return { client, tokens };
}

export async function getUserInfo(
  client: OAuth2Client
): Promise<{ google_id: string; email: string; name: string; picture: string }> {
  const ticket = await client.verifyIdToken({
    idToken: client.credentials.id_token as string,
    audience: getConfig().auth.google_client_id,
  });
  const payload = ticket.getPayload();
  if (!payload) throw new Error('Failed to get user info from Google token');

  return {
    google_id: payload.sub,
    email: payload.email ?? '',
    name: payload.name ?? '',
    picture: payload.picture ?? '',
  };
}

export function tokensToClient(tokens: GoogleTokens, userId?: string): OAuth2Client {
  const client = createOAuth2Client();
  const creds: Credentials = {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expiry_date: tokens.expiry ? new Date(tokens.expiry).getTime() : undefined,
    scope: tokens.scopes?.join(' '),
  };
  client.setCredentials(creds);

  // Persist refreshed tokens back to DB so the next request doesn't need to re-refresh
  if (userId) {
    client.on('tokens', (newCreds) => {
      const update: Partial<GoogleTokens> = {};
      if (newCreds.access_token) update.access_token = newCreds.access_token;
      if (newCreds.refresh_token) update.refresh_token = newCreds.refresh_token;
      if (newCreds.expiry_date) update.expiry = new Date(newCreds.expiry_date).toISOString();
      updateGoogleTokens(userId, update).catch((err) =>
        console.warn('[Google] Failed to persist refreshed tokens:', err)
      );
    });
  }

  return client;
}

export function clientToTokens(client: OAuth2Client): GoogleTokens {
  const creds = client.credentials;
  return {
    access_token: creds.access_token ?? '',
    refresh_token: creds.refresh_token ?? undefined,
    expiry: creds.expiry_date ? new Date(creds.expiry_date).toISOString() : undefined,
    scopes: creds.scope ? creds.scope.split(' ') : SCOPES,
  };
}
