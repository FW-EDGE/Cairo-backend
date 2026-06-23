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

// Memory budget — new streaming approach:
//   Phase 1 sample: 1 000 × 1 536 × 4 B ≈  6 MB
//   Phase 2 cursor batch: 500 × 1 536 × 4 B ≈  3 MB  (released after each batch)
//   Phase 3 projected3D: 15 000 × 3 × 4 B ≈  0.2 MB
//   Node overhead ≈ 100 MB
//   Total peak ≈ ~110 MB — well within 460 MB limit.
const MAX_DOCS     = 15_000;
const PCA_SAMPLE   =  1_000;
const PCA_ITERS    =     20;
const STREAM_BATCH =    500;  // docs projected per iteration in Phase 2

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

function matVecMul(X: number[][], v: number[]): number[] {
  return X.map((row) => dotProduct(row, v));
}

function matTransVecMul(X: number[][], v: number[]): number[] {
  if (X.length === 0) return [];
  const cols = X[0].length;
  const r = new Array<number>(cols).fill(0);
  for (let i = 0; i < X.length; i++)
    for (let j = 0; j < cols; j++) r[j] += X[i][j] * v[i];
  return r;
}

/** Removes variance along `pc` from every row of X — in place. */
function deflateInPlace(X: number[][], pc: number[]): void {
  const scores = matVecMul(X, pc);
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

function normalizeAxis(points: number[][], axis: number): number[] {
  const vals = points.map((p) => p[axis]);
  // Avoid Math.min/max spread — can overflow the call stack with 15k+ points.
  let min = Infinity, max = -Infinity;
  for (const v of vals) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const range = max - min;
  return range === 0 ? vals.map(() => 0) : vals.map((v) => ((v - min) / range) * 2 - 1);
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function computeVectorMap(userId: string): Promise<VectorPoint[]> {
  const col = await embeddingsCol();

  // ── Phase 1: load a small sample to fit PCA ───────────────────────────────
  // Only PCA_SAMPLE docs are fully loaded into RAM here (~6 MB).
  const sampleDocs = await col
    .find({ user_id: new ObjectId(userId) })
    .project({ embedding: 1 })
    .limit(PCA_SAMPLE)
    .toArray();

  const sampleVectors = sampleDocs
    .filter((d) => Array.isArray(d.embedding) && (d.embedding as number[]).length > 0)
    .map((d) => d.embedding as number[]);

  (sampleDocs as unknown[]).length = 0; // release doc objects early

  if (sampleVectors.length < 2) {
    console.log(`[VectorMap] Not enough embeddings for user ${userId}`);
    return [];
  }

  const dims = sampleVectors[0].length;

  // Center sample and compute mean vector
  const mean = new Array<number>(dims).fill(0);
  for (const row of sampleVectors) for (let j = 0; j < dims; j++) mean[j] += row[j];
  for (let j = 0; j < dims; j++) mean[j] /= sampleVectors.length;
  for (const row of sampleVectors) for (let j = 0; j < dims; j++) row[j] -= mean[j];

  // Extract 3 principal components via power iteration on centered sample
  const pcs: number[][] = [];
  for (let k = 0; k < 3; k++) {
    if (!sampleVectors[0]?.length) break;
    const pc = powerIteration(sampleVectors);
    pcs.push(pc);
    deflateInPlace(sampleVectors, pc);
  }
  (sampleVectors as unknown[]).length = 0; // free sample — PCs are all we need now

  if (pcs.length === 0) return [];

  // ── Phase 2: stream all docs via cursor, project in batches ──────────────
  // Peak RAM for this phase: STREAM_BATCH × 1536 × 4B ≈ 3 MB at any one time.
  // Projected 3D coords are tiny (3 floats) — collected for normalization in Phase 3.
  const projected3D: number[][] = [];
  const metadataArr: Omit<VectorPoint, 'x' | 'y' | 'z'>[] = [];

  const cursor = col
    .find({ user_id: new ObjectId(userId) })
    .project({ name: 1, url: 1, type: 1, source: 1, section: 1, preview: 1, embedding: 1 })
    .limit(MAX_DOCS)
    .batchSize(STREAM_BATCH);

  let batchVecs: number[][] = [];
  let batchMeta: Omit<VectorPoint, 'x' | 'y' | 'z'>[] = [];
  const counts: Record<string, number> = {};

  const flushBatch = async () => {
    for (let i = 0; i < batchVecs.length; i++) {
      const c = batchVecs[i].map((v, j) => v - mean[j]); // center
      projected3D.push(pcs.map((pc) => dotProduct(c, pc)));
      metadataArr.push(batchMeta[i]);
    }
    batchVecs = [];
    batchMeta = [];
    // Yield to the event loop so concurrent requests (chat, etc.) aren't starved.
    await new Promise<void>(r => setImmediate(r));
  };

  for await (const doc of cursor) {
    if (!Array.isArray(doc.embedding) || (doc.embedding as number[]).length === 0) continue;

    const src = String(doc.source ?? 'unknown');
    counts[src] = (counts[src] ?? 0) + 1;

    batchVecs.push(doc.embedding as number[]);
    batchMeta.push({
      name:    String(doc.name    ?? ''),
      url:     String(doc.url     ?? ''),
      type:    String(doc.type    ?? ''),
      source:  src,
      section: String(doc.section ?? ''),
      preview: String(doc.preview ?? ''),
    });

    if (batchVecs.length >= STREAM_BATCH) await flushBatch();
  }
  await flushBatch(); // remaining docs

  console.log(`[VectorMap] ${metadataArr.length} embeddings for user ${userId}:`, counts);

  if (metadataArr.length === 0) return [];

  // ── Phase 3: normalize 3D coords across all projected points (tiny data) ──
  const xs = normalizeAxis(projected3D, 0);
  const ys = normalizeAxis(projected3D, 1);
  const zs = normalizeAxis(projected3D, 2);

  return metadataArr.map((m, i) => ({ ...m, x: xs[i], y: ys[i], z: zs[i] }));
}
