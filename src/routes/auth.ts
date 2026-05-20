import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
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

function setCairoTokenCookie(reply: FastifyReply, token: string): void {
  reply.setCookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: EXPIRE_DAYS * 86400,
  });
}

/**
 * Shape expected by the frontend AuthContext AuthUser interface.
 * Maps _id → id and onboarding_completed → onboarding_complete.
 */
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

export async function authRoutes(fastify: FastifyInstance): Promise<void> {
  const config = getConfig();

  // GET /auth/google — start OAuth flow
  fastify.get('/auth/google', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const client = createOAuth2Client();
      const { url, state } = getAuthUrl(client);
      await saveOAuthState(state, { flow: 'login' });

      reply.setCookie('oauth_state', state, {
        httpOnly: true,
        path: '/',
        maxAge: 600,
      });

      return reply.redirect(url);
    } catch (err) {
      console.error('[Auth] /auth/google error:', err);
      return reply.status(500).send({ error: 'Failed to initiate Google OAuth' });
    }
  });

  // GET /auth/google/connect — connect Google to existing account
  fastify.get(
    '/auth/google/connect',
    { preHandler: optionalUser },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        if (!request.user) {
          return reply.redirect(`${config.auth.frontend_url}/login?error=not_authenticated`);
        }

        const client = createOAuth2Client();
        const { url, state } = getAuthUrl(client);
        await saveOAuthState(state, { flow: 'connect', user_id: request.user._id });

        reply.setCookie('oauth_state', state, {
          httpOnly: true,
          path: '/',
          maxAge: 600,
        });

        return reply.redirect(url);
      } catch (err) {
        console.error('[Auth] /auth/google/connect error:', err);
        return reply.redirect(`${config.auth.frontend_url}/login?error=connect_failed`);
      }
    }
  );

  // GET /auth/google/callback
  fastify.get('/auth/google/callback', async (request: FastifyRequest, reply: FastifyReply) => {
    const query = request.query as Record<string, string>;
    const { code, state: queryState, error: oauthError } = query;

    if (oauthError) {
      return reply.redirect(`${config.auth.frontend_url}/login?error=${oauthError}`);
    }

    if (!code || !queryState) {
      return reply.redirect(`${config.auth.frontend_url}/login?error=missing_params`);
    }

    // CSRF validation
    const cookieState = request.cookies?.['oauth_state'];
    if (!cookieState || cookieState !== queryState) {
      return reply.redirect(`${config.auth.frontend_url}/login?error=state_mismatch`);
    }

    const meta = await popOAuthState(queryState);
    if (!meta) {
      return reply.redirect(`${config.auth.frontend_url}/login?error=invalid_state`);
    }

    try {
      const { client, tokens } = await exchangeCode(code);
      const googleUserInfo = await getUserInfo(client);
      const storedTokens = clientToTokens(client);
      // Include token expiry from raw credentials
      if (tokens.expiry_date) {
        storedTokens.expiry = new Date(tokens.expiry_date).toISOString();
      }

      if (meta.flow === 'connect' && meta.user_id) {
        // Connect flow: link Google to existing account
        const user = await connectGoogleUser(
          meta.user_id as string,
          storedTokens,
          googleUserInfo.google_id,
          googleUserInfo.picture
        );

        const token = createToken(user._id, user.email, user.tier);
        setCairoTokenCookie(reply, token);
        reply.clearCookie('oauth_state', { path: '/' });
        return reply.redirect(`${config.auth.frontend_url}/onboarding?connected=true`);
      } else {
        // Login flow
        const user = await upsertGoogleUser(
          googleUserInfo.google_id,
          googleUserInfo.email,
          googleUserInfo.name,
          googleUserInfo.picture,
          storedTokens
        );

        const token = createToken(user._id, user.email, user.tier);
        setCairoTokenCookie(reply, token);
        reply.clearCookie('oauth_state', { path: '/' });
        return reply.redirect(`${config.auth.frontend_url}/auth/callback`);
      }
    } catch (err) {
      console.error('[Auth] callback error:', err);
      reply.clearCookie('oauth_state', { path: '/' });
      return reply.redirect(`${config.auth.frontend_url}/login?error=callback_failed`);
    }
  });

  // GET /auth/me — returns user directly (frontend applies it as-is) or null
  fastify.get(
    '/auth/me',
    { preHandler: optionalUser },
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.user) {
        return reply.send(null);
      }
      return reply.send(toFrontendUser(request.user));
    }
  );

  // POST /auth/register
  fastify.post('/auth/register', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { name, email, password } = request.body as {
        name?: string;
        email: string;
        password: string;
      };

      if (!email || !password) {
        return reply.status(400).send({ error: 'email and password are required' });
      }

      if (password.length < 8) {
        return reply.status(400).send({ error: 'Password must be at least 8 characters' });
      }

      const passwordHash = await hashPassword(password);

      try {
        const user = await createEmailUser(email, name ?? email.split('@')[0], passwordHash);
        const token = createToken(user._id, user.email, user.tier);
        setCairoTokenCookie(reply, token);
        return reply.status(201).send(toFrontendUser(user));
      } catch (createErr: unknown) {
        const msg = createErr instanceof Error ? createErr.message : '';
        if (!msg.includes('already exists')) throw createErr;

        // Email exists — check if it's a Google-only account we can attach a password to
        try {
          const user = await attachPasswordToGoogleUser(email, passwordHash);
          const token = createToken(user._id, user.email, user.tier);
          setCairoTokenCookie(reply, token);
          // 200 (not 201) to signal "existing account updated"
          return reply.send({ ...toFrontendUser(user), password_attached: true });
        } catch (attachErr: unknown) {
          const attachMsg = attachErr instanceof Error ? attachErr.message : '';
          if (attachMsg === 'already_has_password') {
            return reply.status(409).send({ error: 'email_taken', message: 'An account with this email already exists. Try signing in.' });
          }
          // Not a Google account or other issue
          return reply.status(409).send({ error: 'email_taken', message: 'An account with this email already exists. Try signing in.' });
        }
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Registration failed';
      return reply.status(500).send({ error: message });
    }
  });

  // POST /auth/login
  fastify.post('/auth/login', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { email, password } = request.body as { email: string; password: string };

      if (!email || !password) {
        return reply.status(400).send({ error: 'email and password are required' });
      }

      const user = await getUserByEmail(email);

      // Account exists but was created via Google (no password set)
      if (user && !user.password_hash) {
        return reply.status(401).send({
          error: 'google_only',
          message: 'This account was created with Google. Please sign in with Google, or set a password first.',
        });
      }

      if (!user) {
        return reply.status(401).send({ error: 'invalid_credentials', message: 'Invalid email or password.' });
      }

      const valid = await verifyPassword(password, user.password_hash!);
      if (!valid) {
        return reply.status(401).send({ error: 'invalid_credentials', message: 'Invalid email or password.' });
      }

      const token = createToken(user._id, user.email, user.tier);
      setCairoTokenCookie(reply, token);
      return reply.send(toFrontendUser(user));
    } catch (err) {
      console.error('[Auth] login error:', err);
      return reply.status(500).send({ error: 'Login failed' });
    }
  });

  // POST /auth/set-password — let a logged-in user set/change their password
  fastify.post(
    '/auth/set-password',
    { preHandler: requireUser },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { password } = request.body as { password: string };
        if (!password || password.length < 8) {
          return reply.status(400).send({ error: 'Password must be at least 8 characters' });
        }
        const hash = await hashPassword(password);
        const col = await usersCol();
        await col.updateOne(
          { _id: new ObjectId(request.user!._id) },
          { $set: { password_hash: hash } }
        );
        return reply.send({ ok: true });
      } catch (err) {
        console.error('[Auth] set-password error:', err);
        return reply.status(500).send({ error: 'Failed to set password' });
      }
    }
  );

  // POST /auth/logout
  fastify.post('/auth/logout', async (_request: FastifyRequest, reply: FastifyReply) => {
    reply.clearCookie(COOKIE_NAME, { path: '/' });
    return reply.send({ ok: true });
  });

  // POST /auth/onboarding/complete
  fastify.post(
    '/auth/onboarding/complete',
    { preHandler: requireUser },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        await markOnboardingComplete(request.user!._id);
        return reply.send({ ok: true });
      } catch (err) {
        console.error('[Auth] onboarding/complete error:', err);
        return reply.status(500).send({ error: 'Failed to mark onboarding complete' });
      }
    }
  );

  // POST /auth/dev/reset-onboarding
  fastify.post(
    '/auth/dev/reset-onboarding',
    { preHandler: requireUser },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const col = await usersCol();
        await col.updateOne(
          { _id: new ObjectId(request.user!._id) },
          { $set: { onboarding_completed: false } }
        );
        return reply.send({ ok: true });
      } catch (err) {
        console.error('[Auth] reset-onboarding error:', err);
        return reply.status(500).send({ error: 'Failed to reset onboarding' });
      }
    }
  );

  // POST /auth/dev/set-tier
  fastify.post(
    '/auth/dev/set-tier',
    { preHandler: requireUser },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { tier } = request.body as { tier: 'free' | 'pro' | 'business' };
        if (!['free', 'pro', 'business'].includes(tier)) {
          return reply.status(400).send({ error: 'Invalid tier' });
        }
        await setUserTier(request.user!._id, tier);
        return reply.send({ ok: true, tier });
      } catch (err) {
        console.error('[Auth] set-tier error:', err);
        return reply.status(500).send({ error: 'Failed to set tier' });
      }
    }
  );
}
