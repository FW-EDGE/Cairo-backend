import { ObjectId } from 'mongodb';
import { embeddingsCol } from '../db/client.js';

export interface VectorPoint {
  name: string;
  url: string;
  type: string;
  source: string;
  section: string;
  preview: string;
  x: number;
  y: number;
  z: number;
}

// Memory budget (512 MB Render free tier, 460 MB heap):
//   N docs × 1536 floats × 8 bytes = N × 12 KB raw.
//   PCA sample copy: 1500 × 12 KB = 18 MB (one copy only, in-place after that).
//   Node/Express/MongoDB overhead: ~100 MB.
//   15 000 × 12 KB + 18 MB + 100 MB ≈ 298 MB  ← safe headroom.
const MAX_DOCS   = 15_000;
const PCA_SAMPLE = 1_500;
const PCA_ITERS  = 20;

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

/** X·v  (returns new N-length array — small, OK) */
function matVecMul(X: number[][], v: number[]): number[] {
  return X.map((row) => dotProduct(row, v));
}

/** Xᵀ·v  (returns new D-length array — small, OK) */
function matTransVecMul(X: number[][], v: number[]): number[] {
  if (X.length === 0) return [];
  const cols = X[0].length;
  const r = new Array<number>(cols).fill(0);
  for (let i = 0; i < X.length; i++)
    for (let j = 0; j < cols; j++) r[j] += X[i][j] * v[i];
  return r;
}

/**
 * Deflate IN PLACE — removes variance along `pc` from every row of X.
 * Avoids the 3 × 18 MB extra allocations that killed the original version.
 */
function deflateInPlace(X: number[][], pc: number[]): void {
  const scores = matVecMul(X, pc); // small N-length array
  for (let i = 0; i < X.length; i++) {
    const s = scores[i];
    for (let j = 0; j < X[i].length; j++) X[i][j] -= s * pc[j];
  }
}

function powerIteration(X: number[][], iters = PCA_ITERS): number[] {
  const cols = X[0]?.length ?? 0;
  let v = normalize(Array.from({ length: cols }, () => Math.random() * 2 - 1));
  for (let i = 0; i < iters; i++) {
    const Xv   = matVecMul(X, v);
    const XtXv = matTransVecMul(X, Xv);
    const n    = norm(XtXv);
    if (n === 0) break;
    v = XtXv.map((x) => x / n);
  }
  return v;
}

/**
 * Copy a subsample and center it IN PLACE.
 * Returns { sample (centered copy), mean }.
 * One copy of PCA_SAMPLE rows — the only allocation during fitting.
 */
function copyCenterSubsample(
  vectors: number[][],
  n: number,
): { sample: number[][]; mean: number[] } {
  const total = vectors.length;
  const size  = Math.min(n, total);
  const step  = total / size;

  // Deep-copy the subsample rows so we can mutate without touching original vectors
  const sample: number[][] = Array.from(
    { length: size },
    (_, i) => vectors[Math.floor(i * step)].slice(),
  );

  // Compute mean across sample rows
  const cols = sample[0].length;
  const mean = new Array<number>(cols).fill(0);
  for (const row of sample) for (let j = 0; j < cols; j++) mean[j] += row[j];
  for (let j = 0; j < cols; j++) mean[j] /= size;

  // Center in-place
  for (const row of sample) for (let j = 0; j < cols; j++) row[j] -= mean[j];

  return { sample, mean };
}

/**
 * Fit PCA on a subsample, then project ALL vectors.
 * Peak extra allocation: one PCA_SAMPLE × D copy (≈18 MB). No more.
 */
function fitAndProject(vectors: number[][], components = 3): number[][] {
  if (vectors.length < 2) return vectors.map(() => [0, 0, 0]);

  const { sample, mean } = copyCenterSubsample(vectors, PCA_SAMPLE);

  // Extract principal components (in-place deflation — no extra large allocations)
  const pcs: number[][] = [];
  for (let k = 0; k < components; k++) {
    if (!sample[0]?.length) break;
    const pc = powerIteration(sample);
    pcs.push(pc);
    deflateInPlace(sample, pc);
  }

  // sample can be GC'd now
  (sample as unknown as null[]).length = 0;

  if (pcs.length === 0) return vectors.map(() => [0, 0, 0]);

  // Project every vector: center with sample mean, dot with each PC
  return vectors.map((row) => {
    const c = row.map((v, j) => v - mean[j]); // one temporary row at a time
    return pcs.map((pc) => dotProduct(c, pc));
  });
}

function normalizeAxis(points: number[][], axis: number): number[] {
  const vals  = points.map((p) => p[axis]);
  const min   = Math.min(...vals);
  const max   = Math.max(...vals);
  const range = max - min;
  return range === 0 ? vals.map(() => 0) : vals.map((v) => ((v - min) / range) * 2 - 1);
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function computeVectorMap(userId: string): Promise<VectorPoint[]> {
  const col = await embeddingsCol();

  const docs = await col
    .find({ user_id: new ObjectId(userId) })
    .project({ name: 1, url: 1, type: 1, source: 1, section: 1, preview: 1, embedding: 1 })
    .limit(MAX_DOCS)
    .toArray();

  if (docs.length === 0) {
    console.log(`[VectorMap] No embeddings for user ${userId}`);
    return [];
  }

  const valid = docs.filter(
    (d) => Array.isArray(d.embedding) && (d.embedding as number[]).length > 0,
  );
  docs.length = 0; // release raw docs array early

  const counts: Record<string, number> = {};
  valid.forEach((d) => {
    const src = String(d.source ?? 'unknown');
    counts[src] = (counts[src] || 0) + 1;
  });
  console.log(`[VectorMap] ${valid.length} embeddings for user ${userId}:`, counts);

  // Separate metadata (tiny) from vectors (large) so we can free vectors post-PCA
  const metadata = valid.map((d) => ({
    name:    String(d.name    ?? ''),
    url:     String(d.url     ?? ''),
    type:    String(d.type    ?? ''),
    source:  String(d.source  ?? ''),
    section: String(d.section ?? ''),
    preview: String(d.preview ?? ''),
  }));
  const vectors = valid.map((d) => d.embedding as number[]);
  valid.length = 0; // release doc objects (embedding refs still alive via vectors)

  const projected = fitAndProject(vectors, 3);
  vectors.length = 0; // release ~N × 12 KB of embedding data

  const xs = normalizeAxis(projected, 0);
  const ys = normalizeAxis(projected, 1);
  const zs = normalizeAxis(projected, 2);

  return metadata.map((m, i) => ({ ...m, x: xs[i], y: ys[i], z: zs[i] }));
}
