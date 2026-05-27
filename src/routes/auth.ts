import { Router, Request, Response } from 'express';
import {
  createOAuth2Client,
  getAuthUrl,
  exchangeCode,
  getUserInfo,
  clientToTokens,
  tokensToClient,
} from '../auth/google.js';
import {
  upsertGoogleUser,
  getUserById,
  createEmailUser,
  getUserByEmail,
  attachPasswordToGoogleUser,
  markOnboardingComplete,
  setUserTier,
  connectGoogleUser,
  serialize,
} from '../db/users.js';
import { saveOAuthState, popOAuthState } from '../db/oauthStates.js';
import { createToken, COOKIE_NAME, EXPIRE_DAYS } from '../auth/jwt.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { requireUser, optionalUser } from '../auth/middleware.js';
import { getConfig } from '../config.js';
import { usersCol } from '../db/client.js';
import { ObjectId } from 'mongodb';

const IS_PROD = process.env.NODE_ENV === 'production';
const router = Router();

function setCairoTokenCookie(res: Response, token: string): void {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: IS_PROD ? 'none' : 'lax',
    secure: IS_PROD,
    path: '/',
    maxAge: EXPIRE_DAYS * 86400 * 1000, // Express uses milliseconds
  });
}

function toFrontendUser(user: ReturnType<typeof serialize>) {
  if (!user) return null;
  const { _id, password_hash, google_tokens, onboarding_completed, ...rest } = user;
  void google_tokens;
  return {
    id: _id,
    onboarding_complete: onboarding_completed ?? false,
    has_password: !!password_hash,
    ...rest,
  };
}

// GET /auth/google — start OAuth flow
router.get('/auth/google', async (_req: Request, res: Response) => {
  try {
    const client = createOAuth2Client();
    const { url, state } = getAuthUrl(client);
    await saveOAuthState(state, { flow: 'login' });
    res.cookie('oauth_state', state, { httpOnly: true, path: '/', maxAge: 600_000 });
    res.redirect(url);
  } catch (err) {
    console.error('[Auth] /auth/google error:', err);
    res.status(500).json({ error: 'Failed to initiate Google OAuth' });
  }
});

// GET /auth/google/reauth — re-authorise with updated scopes (no logout)
router.get('/auth/google/reauth', requireUser, async (req: Request, res: Response) => {
  const config = getConfig();
  try {
    const client = createOAuth2Client();
    const { url, state } = getAuthUrl(client);
    await saveOAuthState(state, { flow: 'reauth', user_id: req.user!._id });
    res.cookie('oauth_state', state, { httpOnly: true, path: '/', maxAge: 600_000 });
    res.redirect(url);
  } catch (err) {
    console.error('[Auth] /auth/google/reauth error:', err);
    res.redirect(`${config.auth.frontend_url}/dashboard?error=reauth_failed`);
  }
});

// GET /auth/scopes — returns which required scopes the user currently has
router.get('/auth/scopes', requireUser, async (req: Request, res: Response) => {
  const { SCOPES } = await import('../auth/google.js');
  const userScopes = new Set(req.user!.google_tokens?.scopes ?? []);
  // Only check the non-identity scopes (the actual API access ones)
  const required = SCOPES.filter(s => !s.includes('userinfo') && s !== 'openid');
  const missing  = required.filter(s => !userScopes.has(s));
  res.json({ hasAll: missing.length === 0, missing });
});

// GET /auth/google/connect — connect Google to existing account
router.get('/auth/google/connect', optionalUser, async (req: Request, res: Response) => {
  const config = getConfig();
  try {
    if (!req.user) {
      res.redirect(`${config.auth.frontend_url}/login?error=not_authenticated`);
      return;
    }
    const client = createOAuth2Client();
    const { url, state } = getAuthUrl(client);
    await saveOAuthState(state, { flow: 'connect', user_id: req.user._id });
    res.cookie('oauth_state', state, { httpOnly: true, path: '/', maxAge: 600_000 });
    res.redirect(url);
  } catch (err) {
    console.error('[Auth] /auth/google/connect error:', err);
    res.redirect(`${config.auth.frontend_url}/login?error=connect_failed`);
  }
});

// GET /auth/google/callback
router.get('/auth/google/callback', async (req: Request, res: Response) => {
  const config = getConfig();
  const { code, state: queryState, error: oauthError } = req.query as Record<string, string>;

  if (oauthError) { res.redirect(`${config.auth.frontend_url}/login?error=${oauthError}`); return; }
  if (!code || !queryState) { res.redirect(`${config.auth.frontend_url}/login?error=missing_params`); return; }

  const cookieState = req.cookies?.['oauth_state'];
  if (!cookieState || cookieState !== queryState) {
    res.redirect(`${config.auth.frontend_url}/login?error=state_mismatch`);
    return;
  }

  const meta = await popOAuthState(queryState);
  if (!meta) { res.redirect(`${config.auth.frontend_url}/login?error=invalid_state`); return; }

  try {
    const { client, tokens } = await exchangeCode(code);
    const googleUserInfo = await getUserInfo(client);
    const storedTokens = clientToTokens(client);
    if (tokens.expiry_date) {
      storedTokens.expiry = new Date(tokens.expiry_date).toISOString();
    }

    if (meta.flow === 'reauth' && meta.user_id) {
      // Just update tokens — session stays intact, no tier/onboarding changes
      const { updateGoogleTokens } = await import('../db/users.js');
      await updateGoogleTokens(meta.user_id as string, storedTokens);
      res.clearCookie('oauth_state', { path: '/' });
      res.redirect(`${config.auth.frontend_url}/dashboard?reauth=success`);

    } else if (meta.flow === 'connect' && meta.user_id) {
      const user = await connectGoogleUser(
        meta.user_id as string,
        storedTokens,
        googleUserInfo.google_id,
        googleUserInfo.picture
      );
      const token = createToken(user._id, user.email, user.tier);
      setCairoTokenCookie(res, token);
      res.clearCookie('oauth_state', { path: '/' });
      res.redirect(`${config.auth.frontend_url}/onboarding?connected=true`);
    } else {
      const user = await upsertGoogleUser(
        googleUserInfo.google_id,
        googleUserInfo.email,
        googleUserInfo.name,
        googleUserInfo.picture,
        storedTokens
      );
      const token = createToken(user._id, user.email, user.tier);
      setCairoTokenCookie(res, token);
      res.clearCookie('oauth_state', { path: '/' });
      res.redirect(`${config.auth.frontend_url}/auth/callback`);
    }
  } catch (err) {
    console.error('[Auth] callback error:', err);
    res.clearCookie('oauth_state', { path: '/' });
    res.redirect(`${config.auth.frontend_url}/login?error=callback_failed`);
  }
});

// GET /auth/me
router.get('/auth/me', optionalUser, async (req: Request, res: Response) => {
  if (!req.user) { res.json(null); return; }
  res.json(toFrontendUser(req.user));
});

// POST /auth/register
router.post('/auth/register', async (req: Request, res: Response) => {
  try {
    const { name, email, password } = req.body as { name?: string; email: string; password: string };
    if (!email || !password) { res.status(400).json({ error: 'email and password are required' }); return; }
    if (password.length < 8) { res.status(400).json({ error: 'Password must be at least 8 characters' }); return; }

    const passwordHash = await hashPassword(password);
    try {
      const user = await createEmailUser(email, name ?? email.split('@')[0], passwordHash);
      const token = createToken(user._id, user.email, user.tier);
      setCairoTokenCookie(res, token);
      res.status(201).json(toFrontendUser(user));
    } catch (createErr: unknown) {
      const msg = createErr instanceof Error ? createErr.message : '';
      if (!msg.includes('already exists')) throw createErr;
      try {
        const user = await attachPasswordToGoogleUser(email, passwordHash);
        const token = createToken(user._id, user.email, user.tier);
        setCairoTokenCookie(res, token);
        res.json({ ...toFrontendUser(user), password_attached: true });
      } catch (attachErr: unknown) {
        const attachMsg = attachErr instanceof Error ? attachErr.message : '';
        if (attachMsg === 'already_has_password') {
          res.status(409).json({ error: 'email_taken', message: 'An account with this email already exists. Try signing in.' });
          return;
        }
        res.status(409).json({ error: 'email_taken', message: 'An account with this email already exists. Try signing in.' });
      }
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Registration failed';
    res.status(500).json({ error: message });
  }
});

// POST /auth/login
router.post('/auth/login', async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body as { email: string; password: string };
    if (!email || !password) { res.status(400).json({ error: 'email and password are required' }); return; }

    const user = await getUserByEmail(email);
    if (user && !user.password_hash) {
      res.status(401).json({ error: 'google_only', message: 'This account was created with Google. Please sign in with Google, or set a password first.' });
      return;
    }
    if (!user) { res.status(401).json({ error: 'invalid_credentials', message: 'Invalid email or password.' }); return; }

    const valid = await verifyPassword(password, user.password_hash!);
    if (!valid) { res.status(401).json({ error: 'invalid_credentials', message: 'Invalid email or password.' }); return; }

    const token = createToken(user._id, user.email, user.tier);
    setCairoTokenCookie(res, token);
    res.json(toFrontendUser(user));
  } catch (err) {
    console.error('[Auth] login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// POST /auth/set-password
router.post('/auth/set-password', requireUser, async (req: Request, res: Response) => {
  try {
    const { password } = req.body as { password: string };
    if (!password || password.length < 8) { res.status(400).json({ error: 'Password must be at least 8 characters' }); return; }
    const hash = await hashPassword(password);
    const col = await usersCol();
    await col.updateOne({ _id: new ObjectId(req.user!._id) }, { $set: { password_hash: hash } });
    res.json({ ok: true });
  } catch (err) {
    console.error('[Auth] set-password error:', err);
    res.status(500).json({ error: 'Failed to set password' });
  }
});

// POST /auth/logout
router.post('/auth/logout', (_req: Request, res: Response) => {
  res.clearCookie(COOKIE_NAME, { path: '/' });
  res.json({ ok: true });
});

// POST /auth/onboarding/complete
router.post('/auth/onboarding/complete', requireUser, async (req: Request, res: Response) => {
  try {
    await markOnboardingComplete(req.user!._id);
    res.json({ ok: true });
  } catch (err) {
    console.error('[Auth] onboarding/complete error:', err);
    res.status(500).json({ error: 'Failed to mark onboarding complete' });
  }
});

// POST /auth/dev/reset-onboarding
router.post('/auth/dev/reset-onboarding', requireUser, async (req: Request, res: Response) => {
  try {
    const col = await usersCol();
    await col.updateOne({ _id: new ObjectId(req.user!._id) }, { $set: { onboarding_completed: false } });
    res.json({ ok: true });
  } catch (err) {
    console.error('[Auth] reset-onboarding error:', err);
    res.status(500).json({ error: 'Failed to reset onboarding' });
  }
});

// POST /auth/dev/set-tier
router.post('/auth/dev/set-tier', requireUser, async (req: Request, res: Response) => {
  try {
    const { tier } = req.body as { tier: 'free' | 'pro' | 'business' };
    if (!['free', 'pro', 'business'].includes(tier)) { res.status(400).json({ error: 'Invalid tier' }); return; }
    await setUserTier(req.user!._id, tier);
    res.json({ ok: true, tier });
  } catch (err) {
    console.error('[Auth] set-tier error:', err);
    res.status(500).json({ error: 'Failed to set tier' });
  }
});

export default router;
