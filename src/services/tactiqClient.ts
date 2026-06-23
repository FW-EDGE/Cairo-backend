import crypto from 'crypto';
import { getTactiqTokens, saveTactiqTokens, TactiqTokens } from '../db/users.js';

// ── Tactiq MCP Client (OAuth 2.0 + PKCE + Dynamic Client Registration) ───────
// Remote MCP server at https://mcp.tactiq.io
// Auth: Authorization Code + PKCE + RFC 7591 Dynamic Client Registration.
// Tactiq requires DCR — there is no pre-registered static client_id.

const MCP_BASE    = 'https://mcp.tactiq.io';
const AUTH_URL    = 'https://mcp.tactiq.io/oauth/authorize';
const TOKEN_URL   = 'https://mcp.tactiq.io/oauth/token';
const REGISTER_URL = 'https://mcp.tactiq.io/oauth/register';
const SCOPES       = 'mcp:meetings:own mcp:meetings:shared mcp:meetings:spaces mcp:meetings:details';

interface DcrResult {
  client_id:      string;
  client_secret?: string;
}

// In-memory cache — survives for the process lifetime, re-registered on restart.
let _cachedDcr: DcrResult | null = null;

/**
 * Dynamic Client Registration (RFC 7591).
 * Returns { client_id, client_secret? } registered with Tactiq's OAuth server.
 * If Tactiq issues a client_secret (confidential client), it's captured and
 * propagated through the token exchange and stored with the user's tokens.
 */
export async function getOrRegisterClient(redirectUri: string): Promise<DcrResult> {
  if (_cachedDcr) return _cachedDcr;

  const res = await fetch(REGISTER_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name:   'CAIRO',
      redirect_uris: [redirectUri],
      grant_types:   ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope:          SCOPES,
    }),
    signal: AbortSignal.timeout(15_000),
  });

  const body = await res.text();
  console.log('[Tactiq] DCR response', res.status, body.slice(0, 500));

  if (!res.ok) throw new Error(`Tactiq DCR failed (${res.status}): ${body.slice(0, 300)}`);

  const data = JSON.parse(body) as { client_id?: string; client_secret?: string; error?: string };
  if (data.error) throw new Error(`Tactiq DCR error: ${data.error}`);
  if (!data.client_id) throw new Error('Tactiq DCR: no client_id in response');

  _cachedDcr = { client_id: data.client_id, client_secret: data.client_secret };
  console.log('[Tactiq] Dynamic client registered:', data.client_id, data.client_secret ? '(confidential)' : '(public)');
  return _cachedDcr;
}

/** Kept for back-compat with any callers that only need client_id. */
export async function getOrRegisterClientId(redirectUri: string): Promise<string> {
  return (await getOrRegisterClient(redirectUri)).client_id;
}

// ── PKCE helpers ──────────────────────────────────────────────────────────────

export function generateCodeVerifier(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export function generateCodeChallenge(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

export function buildAuthorizationUrl(
  redirectUri:   string,
  state:         string,
  codeChallenge: string,
  clientId:      string,
): string {
  const params = new URLSearchParams({
    response_type:         'code',
    client_id:             clientId,
    redirect_uri:          redirectUri,
    scope:                 SCOPES,
    state,
    code_challenge:        codeChallenge,
    code_challenge_method: 'S256',
  });
  return `${AUTH_URL}?${params.toString()}`;
}

export async function exchangeCodeForTokens(
  code:          string,
  redirectUri:   string,
  verifier:      string,
  clientId:      string,
  clientSecret?: string,
): Promise<TactiqTokens> {
  const params = new URLSearchParams({
    grant_type:    'authorization_code',
    code,
    redirect_uri:  redirectUri,
    code_verifier: verifier,
  });

  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' };

  if (clientSecret) {
    // Confidential client — authenticate via HTTP Basic (RFC 6749 §2.3.1)
    const cred = Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`).toString('base64');
    headers['Authorization'] = `Basic ${cred}`;
  } else {
    // Public client — include client_id in body
    params.set('client_id', clientId);
  }

  const res = await fetch(TOKEN_URL, {
    method:  'POST',
    headers,
    body:    params.toString(),
    signal:  AbortSignal.timeout(15_000),
  });

  const text = await res.text().catch(() => '');
  console.log('[Tactiq] token exchange', res.status, text.slice(0, 300));

  if (!res.ok) throw new Error(`Tactiq token exchange failed (${res.status}): ${text.slice(0, 200)}`);

  const data = JSON.parse(text) as {
    access_token:  string;
    refresh_token?: string;
    expires_in?:   number;
    scope?:        string;
  };

  const expiry = data.expires_in
    ? new Date(Date.now() + data.expires_in * 1000).toISOString()
    : undefined;

  return {
    access_token:  data.access_token,
    refresh_token: data.refresh_token,
    expiry,
    scopes:        (data.scope ?? SCOPES).split(' '),
    client_id:     clientId,
    client_secret: clientSecret,
  };
}

async function refreshAccessToken(userId: string, tokens: TactiqTokens): Promise<TactiqTokens | null> {
  if (!tokens.refresh_token) return null;

  try {
    const params = new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: tokens.refresh_token,
    });

    const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' };

    if (tokens.client_secret) {
      const cred = Buffer.from(`${encodeURIComponent(tokens.client_id)}:${encodeURIComponent(tokens.client_secret)}`).toString('base64');
      headers['Authorization'] = `Basic ${cred}`;
    } else {
      params.set('client_id', tokens.client_id);
    }

    const res = await fetch(TOKEN_URL, {
      method:  'POST',
      headers,
      body:    params.toString(),
      signal:  AbortSignal.timeout(10_000),
    });

    if (!res.ok) return null;

    const data = await res.json() as {
      access_token:  string;
      refresh_token?: string;
      expires_in?:   number;
    };

    const fresh: TactiqTokens = {
      access_token:   data.access_token,
      refresh_token:  data.refresh_token ?? tokens.refresh_token,
      expiry:         data.expires_in ? new Date(Date.now() + data.expires_in * 1000).toISOString() : undefined,
      scopes:         tokens.scopes,
      client_id:      tokens.client_id,
      client_secret:  tokens.client_secret, // carry forward
    };

    await saveTactiqTokens(userId, fresh);
    return fresh;
  } catch {
    return null;
  }
}

function isTokenExpired(tokens: TactiqTokens): boolean {
  if (!tokens.expiry) return false;
  return Date.now() > new Date(tokens.expiry).getTime() - 60_000; // 1 min margin
}

// ── MCP protocol ──────────────────────────────────────────────────────────────

interface MCPTool {
  name:        string;
  description: string;
  inputSchema: { type: string; properties: Record<string, any>; required?: string[] };
}

interface MCPResponse {
  jsonrpc: string;
  id:      number;
  result?: any;
  error?:  { code: number; message: string };
}

const _toolsCache = new Map<string, MCPTool[]>(); // userId → tools
let _requestId = 1;

async function mcpRequest(accessToken: string, method: string, params: any): Promise<any> {
  const id   = _requestId++;
  const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });

  const res = await fetch(MCP_BASE, {
    method:  'POST',
    headers: {
      'Content-Type':    'application/json',
      'Authorization':   `Bearer ${accessToken}`,
      'Accept':          'application/json, text/event-stream',
      'Accept-Encoding': 'identity', // prevent gzip on Render
    },
    body,
    signal: AbortSignal.timeout(30_000),
  });

  if (res.status === 401) throw new Error('__UNAUTHORIZED__');
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Tactiq MCP HTTP ${res.status}: ${text.slice(0, 200)}`);
  }

  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('text/event-stream')) return parseSseResponse(await res.text());

  const json: MCPResponse = await res.json();
  if (json.error) throw new Error(`Tactiq MCP error: ${json.error.message}`);
  return json.result;
}

function parseSseResponse(text: string): any {
  let lastResult: any = null;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const raw = trimmed.slice(5).trim();
    if (raw === '[DONE]') break;
    try {
      const msg: MCPResponse = JSON.parse(raw);
      if (msg.error) throw new Error(`Tactiq MCP error: ${msg.error.message}`);
      if (msg.result !== undefined) lastResult = msg.result;
    } catch { /* ignore non-JSON lines */ }
  }
  return lastResult;
}

async function getValidToken(userId: string): Promise<string> {
  let tokens = await getTactiqTokens(userId);
  if (!tokens) throw new Error('Tactiq no está conectado. Conectá tu cuenta desde la sección de integraciones.');

  if (isTokenExpired(tokens)) {
    const refreshed = await refreshAccessToken(userId, tokens);
    if (!refreshed) throw new Error('El token de Tactiq expiró. Reconectá tu cuenta.');
    tokens = refreshed;
  }
  return tokens.access_token;
}

async function mcpRequestForUser(userId: string, method: string, params: any): Promise<any> {
  let accessToken = await getValidToken(userId);
  try {
    return await mcpRequest(accessToken, method, params);
  } catch (err: any) {
    if (err.message !== '__UNAUTHORIZED__') throw err;
    // Token may have just expired — try one refresh
    const tokens = await getTactiqTokens(userId);
    const refreshed = tokens ? await refreshAccessToken(userId, tokens) : null;
    if (!refreshed) throw new Error('Sesión de Tactiq expirada. Reconectá tu cuenta.');
    return await mcpRequest(refreshed.access_token, method, params);
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function listTactiqTools(userId: string): Promise<MCPTool[]> {
  if (_toolsCache.has(userId)) return _toolsCache.get(userId)!;
  const result = await mcpRequestForUser(userId, 'tools/list', {});
  const tools: MCPTool[] = result?.tools ?? [];
  _toolsCache.set(userId, tools);
  return tools;
}

export async function callTactiqTool(userId: string, name: string, args: Record<string, any>): Promise<string> {
  const result = await mcpRequestForUser(userId, 'tools/call', { name, arguments: args });

  if (result?.content) {
    const parts: string[] = (result.content as any[])
      .filter(c => c.type === 'text')
      .map(c => c.text as string);
    return parts.join('\n').trim() || '(sin contenido)';
  }
  if (typeof result === 'string') return result;
  return JSON.stringify(result, null, 2);
}

export async function getTactiqOpenAIToolDefs(userId: string): Promise<any[]> {
  const tools = await listTactiqTools(userId);
  return tools.map(t => ({
    type: 'function',
    function: {
      name:        `tactiq_${t.name}`,
      description: t.description,
      parameters:  t.inputSchema,
    },
  }));
}

export function clearTactiqCache(userId: string): void {
  _toolsCache.delete(userId);
}

export function isTactiqTool(fn: string): boolean {
  return fn.startsWith('tactiq_');
}

export function getTactiqToolLabel(fn: string): string {
  const name = fn.replace(/^tactiq_/, '');
  if (name.includes('search'))  return '🎙️ Buscando en Tactiq…';
  if (name.includes('list') || name.includes('recent')) return '🎙️ Listando reuniones…';
  if (name.includes('get') || name.includes('transcript')) return '🎙️ Obteniendo transcripción…';
  return '🎙️ Consultando Tactiq…';
}
