import { FastifyRequest, FastifyReply } from 'fastify';
import { COOKIE_NAME, decodeToken } from './jwt.js';
import { getUserById, AppUser } from '../db/users.js';

declare module 'fastify' {
  interface FastifyRequest {
    user: AppUser | null;
  }
}

export async function requireUser(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = request.cookies?.[COOKIE_NAME];
  if (!token) {
    reply.status(401).send({ error: 'Not authenticated' });
    return;
  }

  const payload = decodeToken(token);
  if (!payload?.sub) {
    reply.status(401).send({ error: 'Invalid token' });
    return;
  }

  const user = await getUserById(payload.sub);
  if (!user) {
    reply.status(401).send({ error: 'User not found' });
    return;
  }

  request.user = user;
}

export async function optionalUser(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  request.user = null;
  const token = request.cookies?.[COOKIE_NAME];
  if (!token) return;

  const payload = decodeToken(token);
  if (!payload?.sub) return;

  const user = await getUserById(payload.sub);
  request.user = user;
}
