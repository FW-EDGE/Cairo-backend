import jwt from 'jsonwebtoken';
import { getConfig } from '../config.js';

export const COOKIE_NAME = 'cairo_token';
export const EXPIRE_DAYS = 7;

export interface JwtPayload {
  sub: string;
  email: string;
  tier: string;
  iat?: number;
  exp?: number;
}

export function createToken(userId: string, email: string, tier: string): string {
  const config = getConfig();
  const payload: JwtPayload = { sub: userId, email, tier };
  return jwt.sign(payload, config.auth.jwt_secret, {
    algorithm: 'HS256',
    expiresIn: `${EXPIRE_DAYS}d`,
  });
}

export function decodeToken(token: string): JwtPayload | null {
  const config = getConfig();
  try {
    const decoded = jwt.verify(token, config.auth.jwt_secret, { algorithms: ['HS256'] });
    return decoded as JwtPayload;
  } catch {
    return null;
  }
}
