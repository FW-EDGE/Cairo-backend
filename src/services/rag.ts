import { ObjectId } from 'mongodb';
import OpenAI from 'openai';
import { driveCacheCol, embeddingsCol } from '../db/client.js';
import { getConfig } from '../config.js';
import { DriveFile } from '../db/driveCache.js';
import { recordTokenUsage } from '../db/users.js';

export const STOPWORDS_ES = new Set([
  'a', 'al', 'algo', 'algunas', 'algunos', 'ante', 'antes', 'como', 'con', 'contra',
  'cual', 'cuando', 'de', 'del', 'desde', 'donde', 'durante', 'e', 'el', 'ella',
  'ellas', 'ellos', 'en', 'entre', 'era', 'erais', 'eran', 'eras', 'eres', 'es',
  'esa', 'esas', 'ese', 'eso', 'esos', 'esta', 'estaba', 'estaban', 'estado',
  'estas', 'este', 'esto', 'estos', 'fue', 'fueron', 'hay', 'he', 'la', 'las',
  'le', 'les', 'lo', 'los', 'me', 'mi', 'mia', 'mías', 'mis', 'mismo', 'mucho',
  'muy', 'más', 'mi', 'nada', 'ni', 'no', 'nos', 'nosotras', 'nosotros', 'o',
  'os', 'otra', 'otras', 'otro', 'otros', 'para', 'pero', 'por', 'porque', 'que',
  'quien', 'quienes', 'qué', 'se', 'sea', 'ser', 'si', 'sin', 'sobre', 'son',
  'su', 'sus', 'también', 'tanto', 'te', 'tengo', 'ti', 'tiene', 'todo', 'todos',
  'tu', 'tus', 'un', 'una', 'unas', 'unos', 'usted', 'ustedes', 'vos', 'vosotras',
  'vosotros', 'y', 'ya', 'yo', 'él', 'éste', 'ésta', 'éstos', 'éstas',
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-záéíóúüñ0-9\s]/gi, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOPWORDS_ES.has(t));
}

function flattenFiles(files: DriveFile[]): DriveFile[] {
  const result: DriveFile[] = [];
  function walk(f: DriveFile) {
    result.push(f);
    if (f.children) f.children.forEach(walk);
  }
  files.forEach(walk);
  return result;
}

export async function searchDriveCache(
  userId: string,
  query: string,
  maxResults = 30
): Promise<{ context: string; items: RagHit[] }> {
  const col = await driveCacheCol();
  const doc = await col.findOne({ user_id: new ObjectId(userId) });
  if (!doc) return { context: '', items: [] };

  const tokens = tokenize(query);
  if (tokens.length === 0) return { context: '', items: [] };

  const allFiles = [
    ...flattenFiles((doc.mydrive as DriveFile[]) || []),
    ...flattenFiles((doc.shared as DriveFile[]) || []),
  ];

  // Score files by token matches in name
  const scored = allFiles
    .map((f) => {
      const nameLower = f.name.toLowerCase();
      const score = tokens.filter((t) => nameLower.includes(t)).length;
      return { file: f, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults);

  if (scored.length === 0) return { context: '', items: [] };

  // Expand folders to include children
  const matchedIds = new Set(scored.map((x) => x.file.id));
  const expanded: DriveFile[] = [];
  for (const { file } of scored) {
    expanded.push(file);
    if (file.children) {
      file.children.forEach((c) => {
        if (!matchedIds.has(c.id)) {
          expanded.push(c);
          matchedIds.add(c.id);
        }
      });
    }
  }

  const items: RagHit[] = expanded.map((f) => ({
    name: f.name,
    url: f.webViewLink ?? '',
    type: f.type,
    source: 'drive',
  }));

  return {
    context: formatDriveHits(expanded, 'Archivos relevantes en Drive'),
    items,
  };
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot   += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

async function searchEmbeddingsInMemory(
  userId: string,
  queryVector: number[],
  maxResults: number
): Promise<Array<{ name: string; url: string; type: string; source: string; section: string; text: string; score: number }>> {
  const col = await embeddingsCol();
  const uid = new ObjectId(userId);

  // Fetch up to 200 Drive docs + up to 100 Gmail docs separately so Gmail is never
  // crowded out by the larger Drive corpus (Render free tier: 512 MB RAM limit).
  const [driveDocs, gmailDocs] = await Promise.all([
    col.find({ user_id: uid, source: { $ne: 'gmail' } })
      .sort({ indexed_at: -1 }).limit(200)
      .project({ name: 1, url: 1, type: 1, source: 1, section: 1, text: 1, embedding: 1 })
      .toArray(),
    col.find({ user_id: uid, source: 'gmail' })
      .sort({ indexed_at: -1 }).limit(100)
      .project({ name: 1, url: 1, type: 1, source: 1, section: 1, text: 1, embedding: 1 })
      .toArray(),
  ]);
  const docs = [...driveDocs, ...gmailDocs];

  if (docs.length === 0) return [];

  const scored = docs
    .filter((d) => Array.isArray(d.embedding))
    .map((d) => ({
      name:    String(d.name ?? ''),
      url:     String(d.url ?? ''),
      type:    String(d.type ?? ''),
      source:  String(d.source ?? ''),
      section: String(d.section ?? ''),
      text:    String(d.text ?? ''),
      score:   cosineSimilarity(queryVector, d.embedding as number[]),
    }))
    .sort((a, b) => b.score - a.score);

  // Deduplicate by name+url, keep highest score
  const seen = new Set<string>();
  const deduped = scored.filter((r) => {
    const key = `${r.name}::${r.url}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return deduped.slice(0, maxResults);
}

export interface RagHit {
  name:   string;
  url:    string;
  type:   string;
  source: string;
}

export async function searchEmbeddings(
  userId: string,
  query: string,
  maxResults = 12
): Promise<{ context: string; items: RagHit[] }> {
  const config = getConfig();
  const openai = new OpenAI({ apiKey: config.llm.openai.api_key });

  const embeddingRes = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: query,
  });
  const queryVector = embeddingRes.data[0].embedding;
  const queryTokens = embeddingRes.usage?.total_tokens ?? 0;
  if (queryTokens > 0) recordTokenUsage(userId, { embedding_tokens: queryTokens }).catch(() => {});

  const col = await embeddingsCol();
  let results: Array<{ name: string; url: string; type: string; source: string; section: string; text: string; score: number }> = [];

  // Try Atlas Vector Search first; fall back to in-memory cosine if index doesn't exist
  try {
    const pipeline = [
      {
        $vectorSearch: {
          index: config.mongodb.vector_index ?? 'vector_index',
          path: 'embedding',
          queryVector,
          numCandidates: maxResults * 15,
          limit: maxResults * 4,
          filter: { user_id: new ObjectId(userId) },
        },
      },
      {
        $project: { name: 1, url: 1, type: 1, source: 1, section: 1, text: 1, score: { $meta: 'vectorSearchScore' } },
      },
    ];
    const raw = await col.aggregate(pipeline).toArray();

    // Deduplicate
    const seen = new Set<string>();
    results = raw
      .filter((r) => { const k = `${r.name}::${r.url}`; if (seen.has(k)) return false; seen.add(k); return true; })
      .slice(0, maxResults)
      .map((r) => ({ name: String(r.name ?? ''), url: String(r.url ?? ''), type: String(r.type ?? ''), source: String(r.source ?? ''), section: String(r.section ?? ''), text: String(r.text ?? ''), score: r.score ?? 0 }));

    console.log(`[RAG] Atlas vector search: ${results.length} results`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // Only warn once per process start to avoid log spam
    if (!(searchEmbeddings as any)._warnedFallback) {
      console.warn(`[RAG] Atlas vector index not found — using in-memory fallback (limited to 300 docs). Create a vector index named "${config.mongodb.vector_index}" in Atlas to fix this.`);
      (searchEmbeddings as any)._warnedFallback = true;
    }
    results = await searchEmbeddingsInMemory(userId, queryVector, maxResults);
  }

  if (results.length === 0) return { context: '', items: [] };

  // Only include results with decent similarity
  const filtered = results.filter((r) => r.score > 0.25);
  if (filtered.length === 0) return { context: '', items: [] };

  const lines = filtered.map((r, i) => {
    const source = r.source === 'gmail' ? '📧 Gmail' : '📄 Drive';
    const header = `[${i + 1}] ${source} — **${r.name}**${r.url ? ` (${r.url})` : ''}`;
    const excerpt = r.text ? `\n${String(r.text).slice(0, 500)}` : '';
    return `${header}${excerpt}`;
  });

  const context = `### Fragmentos indexados del usuario (búsqueda semántica)\n\n${lines.join('\n\n---\n\n')}`;
  const items: RagHit[] = filtered.map((r) => ({ name: r.name, url: r.url, type: r.type, source: r.source }));

  return { context, items };
}

export function buildSearchQuery(
  message: string,
  history: Array<{ role: string; content: string }>
): string {
  const userTurns = history
    .filter((m) => m.role === 'user')
    .slice(-2)
    .map((m) => m.content);
  return [...userTurns, message].join(' ');
}

export async function buildContextBlock(
  userId: string,
  message: string,
  tier: string,
  history: Array<{ role: string; content: string }>
): Promise<{ context: string; items: RagHit[] }> {
  const msgLower = message.toLowerCase();

  // 1. Skip highlighting for very generic commands or with typos
  const reportTerms = ['informe', 'reporte', 'sow', 'ifnrome', 'infmorme', 'report'];
  const actionTerms = ['gener', 'crear', 'hacer', 'hace'];
  
  const hasAction = actionTerms.some(t => msgLower.includes(t));
  const hasReport = reportTerms.some(t => msgLower.includes(t));
  
  const isGenericReportRequest = hasAction && hasReport && !msgLower.includes(' de ') && !msgLower.includes(' sobre ');

  // Intent detection
  const wantsFolders = msgLower.includes('carpeta');
  const wantsMails = msgLower.includes('mail') || msgLower.includes('correo');
  const wantsFiles = (msgLower.includes('archivo') || msgLower.includes('documento')) && !wantsFolders;
  const wantsEverything = !wantsFolders && !wantsMails && !wantsFiles;

  try {
    let allItems: RagHit[] = [];
    let contextParts: string[] = [];

    // 2. Critical: If it's a broad request, skip highlighting to avoid "random" dots
    if (isGenericReportRequest) {
      return { context: '', items: [] };
    }

    const searchQuery = buildSearchQuery(message, history);

    if (tier === 'free') {
      const driveResult = await searchDriveCache(userId, searchQuery).catch(() => ({ context: '', items: [] }));
      contextParts.push(driveResult.context);
      allItems = driveResult.items;
    } else {
      const embedResult = await searchEmbeddings(userId, searchQuery).catch((err) => {
        console.warn('[RAG] Vector search failed:', err?.message ?? err);
        return { context: '', items: [] as RagHit[] };
      });
      const driveResult = await searchDriveCache(userId, searchQuery).catch(() => ({ context: '', items: [] as RagHit[] }));
      
      contextParts = [embedResult.context, driveResult.context].filter(Boolean);
      allItems = [...embedResult.items, ...driveResult.items];
    }

    // Filter items and context based on intent
    let filteredItems = allItems;
    if (!wantsEverything) {
      filteredItems = allItems.filter(item => {
        if (wantsFolders && item.type === 'folder') return true;
        if (wantsMails && item.source === 'gmail') return true;
        if (wantsFiles && item.source === 'drive' && item.type !== 'folder') return true;
        return false;
      });
    }

    // Deduplicate items by URL
    const seenUrls = new Set<string>();
    filteredItems = filteredItems.filter(item => {
      if (!item.url) return true;
      if (seenUrls.has(item.url)) return false;
      seenUrls.add(item.url);
      return true;
    });

    if (contextParts.length === 0) {
      return {
        context: '(No se encontraron fragmentos relevantes.)',
        items: [],
      };
    }

    // 5. Final check: if too many items, don't highlight anything (it's "random" noise)
    const finalItems = filteredItems.length > 8 ? [] : filteredItems;

    return { 
      context: contextParts.join('\n\n---\n\n'), 
      items: finalItems 
    };
  } catch (err) {
    console.error('[RAG] buildContextBlock error:', err);
    return { context: '', items: [] };
  }
}

export function formatDriveHits(hits: DriveFile[], header: string): string {
  if (hits.length === 0) return '';

  const lines = hits.map((f) => {
    const parts = [`**${f.name}**`, `(${f.type || f.mimeType})`];
    if (f.webViewLink) parts.push(`[abrir](${f.webViewLink})`);
    if (f.modifiedTime) parts.push(`modificado: ${f.modifiedTime.slice(0, 10)}`);
    return parts.join(' ');
  });

  return `### ${header}\n${lines.join('\n')}`;
}
