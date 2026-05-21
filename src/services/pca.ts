import { ObjectId } from 'mongodb';
import { embeddingsCol } from '../db/client.js';

export interface VectorPoint {
  name: string;
  url: string;
  type: string;
  source: string;
  section: string;
  preview: string;   // first ~160 chars of text, for card display
  x: number;
  y: number;
  z: number;
}

// Hard cap: each embedding is 1536 floats × 8 bytes = 12 KB.
// 4 000 docs × 12 KB = 48 MB raw; PCA creates ~3× copies → ~150 MB peak. Safe for 512 MB instances.
const MAX_DOCS     = 4_000;  // total embeddings loaded from DB
const PCA_SAMPLE   = 1_500;  // vectors used to fit the PCA components
const PCA_ITERS    = 20;     // power-iteration steps

// ── Linear algebra helpers ────────────────────────────────────────────────────

function dotProduct(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function norm(v: number[]): number {
  return Math.sqrt(dotProduct(v, v));
}

function normalize(v: number[]): number[] {
  const n = norm(v);
  return n === 0 ? v.map(() => 0) : v.map((x) => x / n);
}

/** X·v */
function matVecMul(X: number[][], v: number[]): number[] {
  return X.map((row) => dotProduct(row, v));
}

/** Xᵀ·v */
function matTransVecMul(X: number[][], v: number[]): number[] {
  if (X.length === 0) return [];
  const cols = X[0].length;
  const r = new Array<number>(cols).fill(0);
  for (let i = 0; i < X.length; i++)
    for (let j = 0; j < cols; j++) r[j] += X[i][j] * v[i];
  return r;
}

/** Deflate the matrix by removing the variance along `pc`. */
function deflate(X: number[][], pc: number[]): number[][] {
  const scores = matVecMul(X, pc);
  return X.map((row, i) => row.map((val, j) => val - scores[i] * pc[j]));
}

function powerIteration(X: number[][], iters = PCA_ITERS): number[] {
  const cols = X[0]?.length ?? 0;
  let v = normalize(Array.from({ length: cols }, () => Math.random() * 2 - 1));
  for (let i = 0; i < iters; i++) {
    const Xv    = matVecMul(X, v);
    const XtXv  = matTransVecMul(X, Xv);
    const n = norm(XtXv);
    if (n === 0) break;
    v = XtXv.map((x) => x / n);
  }
  return v;
}

function centerMatrix(X: number[][]): { centered: number[][]; mean: number[] } {
  if (X.length === 0) return { centered: [], mean: [] };
  const cols = X[0].length;
  const mean = new Array<number>(cols).fill(0);
  for (const row of X) for (let j = 0; j < cols; j++) mean[j] += row[j];
  for (let j = 0; j < cols; j++) mean[j] /= X.length;
  return { centered: X.map((row) => row.map((v, j) => v - mean[j])), mean };
}

/**
 * Evenly-spaced subsample (deterministic, no shuffling needed because
 * MongoDB returns docs in natural order which is varied enough).
 */
function subsample(vectors: number[][], n: number): number[][] {
  if (vectors.length <= n) return vectors;
  const step = vectors.length / n;
  return Array.from({ length: n }, (_, i) => vectors[Math.floor(i * step)]);
}

/**
 * Fit PCA on a subsample, then project ALL vectors.
 * This is O(sample × dim × iters) for fitting + O(n × dim × components) for projection.
 */
function fitAndProject(vectors: number[][], components = 3): number[][] {
  if (vectors.length < 2) return vectors.map(() => [0, 0, 0]);

  // Fit on a representative subsample
  const sample = subsample(vectors, PCA_SAMPLE);
  const { centered: centeredSample, mean } = centerMatrix(sample);

  let X = centeredSample;
  const pcs: number[][] = [];
  for (let k = 0; k < components; k++) {
    if (!X[0]?.length) break;
    const pc = powerIteration(X);
    pcs.push(pc);
    X = deflate(X, pc);
  }

  if (pcs.length === 0) return vectors.map(() => [0, 0, 0]);

  // Project every vector (center with sample mean, then dot with each PC)
  return vectors.map((row) => {
    const c = row.map((v, j) => v - mean[j]);
    return pcs.map((pc) => dotProduct(c, pc));
  });
}

function normalizeAxis(points: number[][], axis: number): number[] {
  const vals = points.map((p) => p[axis]);
  const min  = Math.min(...vals);
  const max  = Math.max(...vals);
  const range = max - min;
  return range === 0 ? vals.map(() => 0) : vals.map((v) => ((v - min) / range) * 2 - 1);
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function computeVectorMap(userId: string): Promise<VectorPoint[]> {
  const col  = await embeddingsCol();

  // Load embeddings with a hard cap to prevent OOM on free-tier (512 MB RAM).
  // Each embedding vector is 1536 floats × 8 bytes = ~12 KB; PCA creates ~3× copies.
  const docs = await col
    .find({ user_id: new ObjectId(userId) })
    .project({ name: 1, url: 1, type: 1, source: 1, section: 1, preview: 1, embedding: 1 })
    .limit(MAX_DOCS)
    .toArray();

  if (docs.length === 0) {
    console.log(`[VectorMap] No embeddings found for user ${userId}`);
    return [];
  }

  // Keep only docs with a valid embedding vector
  const valid = docs.filter((d) => Array.isArray(d.embedding) && (d.embedding as number[]).length > 0);

  const counts: Record<string, number> = {};
  valid.forEach((d) => {
    const src = String(d.source ?? 'unknown');
    counts[src] = (counts[src] || 0) + 1;
  });
  console.log(`[VectorMap] ${valid.length} valid embeddings for user ${userId}:`, counts);

  const vectors   = valid.map((d) => d.embedding as number[]);
  // Free raw doc data before PCA (keeps peak memory lower)
  docs.length = 0;
  const projected = fitAndProject(vectors, 3);
  // Free raw vectors after projection
  vectors.length = 0;

  const xs = normalizeAxis(projected, 0);
  const ys = normalizeAxis(projected, 1);
  const zs = normalizeAxis(projected, 2);

  return valid.map((d, i) => {
    return {
      name:    String(d.name    ?? ''),
      url:     String(d.url     ?? ''),
      type:    String(d.type    ?? ''),
      source:  String(d.source  ?? ''),
      section: String(d.section ?? ''),
      preview: String(d.preview ?? ''),
      x: xs[i],
      y: ys[i],
      z: zs[i],
    };
  });
}
