import { Request, Response, NextFunction } from 'express';
import { COOKIE_NAME, decodeToken } from './jwt.js';
import { getUserById, AppUser } from '../db/users.js';

// Extend Express Request to carry the authenticated user
declare global {
  namespace Express {
    interface Request {
      user: AppUser | null;
    }
  }
}

export async function requireUser(req: Request, res: Response, next: NextFunction): Promise<void> {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const payload = decodeToken(token);
  if (!payload?.sub) {
    res.status(401).json({ error: 'Invalid token' });
    return;
  }

  const user = await getUserById(payload.sub);
  if (!user) {
    res.status(401).json({ error: 'User not found' });
    return;
  }

  req.user = user;
  next();
}

export async function optionalUser(req: Request, _res: Response, next: NextFunction): Promise<void> {
  req.user = null;
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) { next(); return; }

  const payload = decodeToken(token);
  if (!payload?.sub) { next(); return; }

  const user = await getUserById(payload.sub);
  req.user = user;
  next();
}
