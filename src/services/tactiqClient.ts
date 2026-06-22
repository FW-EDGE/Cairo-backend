import crypto from 'crypto';
import { getTactiqTokens, saveTactiqTokens, TactiqTokens } from '../db/users.js';

// ── Tactiq MCP Client (OAuth 2.0 + PKCE, public client) ──────────────────────
// Remote MCP server at https://mcp.tactiq.io
// Auth: Authorization Code + PKCE, no client_secret required.

const MCP_BASE  = 'https://mcp.tactiq.io';
const AUTH_URL  = 'https://mcp.tactiq.io/oauth/authorize';
const TOKEN_URL = 'https://mcp.tactiq.io/oauth/token';
const SCOPES    = 'mcp:meetings:own mcp:meetings:shared mcp:meetings:spaces mcp:meetings:details';

// The client_id for CAIRO — used as the OAuth app identifier (no secret needed)
const CLIENT_ID = 'cairo-mcp-client';

// ── PKCE helpers ──────────────────────────────────────────────────────────────

export function generateCodeVerifier(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export function generateCodeChallenge(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

export function buildAuthorizationUrl(redirectUri: string, state: string, codeChallenge: string): string {
  const params = new URLSearchParams({
    response_type:          'code',
    client_id:              CLIENT_ID,
    redirect_uri:           redirectUri,
    scope:                  SCOPES,
    state,
    code_challenge:         codeChallenge,
    code_challenge_method:  'S256',
  });
  return `${AUTH_URL}?${params.toString()}`;
}

export async function exchangeCodeForTokens(
  code:        string,
  redirectUri: string,
  verifier:    string,
): Promise<TactiqTokens> {
  const body = new URLSearchParams({
    grant_type:    'authorization_code',
    client_id:     CLIENT_ID,
    code,
    redirect_uri:  redirectUri,
    code_verifier: verifier,
  });

  const res = await fetch(TOKEN_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    body.toString(),
    signal:  AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Tactiq token exchange failed (${res.status}): ${text.slice(0, 200)}`);
  }

  const data = await res.json() as {
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
    scopes: (data.scope ?? SCOPES).split(' '),
  };
}

async function refreshAccessToken(userId: string, tokens: TactiqTokens): Promise<TactiqTokens | null> {
  if (!tokens.refresh_token) return null;

  try {
    const body = new URLSearchParams({
      grant_type:    'refresh_token',
      client_id:     CLIENT_ID,
      refresh_token: tokens.refresh_token,
    });

    const res = await fetch(TOKEN_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    body.toString(),
      signal:  AbortSignal.timeout(10_000),
    });

    if (!res.ok) return null;

    const data = await res.json() as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
    };

    const fresh: TactiqTokens = {
      access_token:  data.access_token,
      refresh_token: data.refresh_token ?? tokens.refresh_token,
      expiry:        data.expires_in ? new Date(Date.now() + data.expires_in * 1000).toISOString() : undefined,
      scopes:        tokens.scopes,
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
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${accessToken}`,
      'Accept':        'application/json, text/event-stream',
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
