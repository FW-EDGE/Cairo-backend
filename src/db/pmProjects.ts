import { ObjectId } from 'mongodb';
import { getDb } from './client.js';

export type ProjectStatus = 'planning' | 'active' | 'completed' | 'on_hold';

export interface PmProject {
  _id: string;
  owner_id: string;
  name: string;
  drive_doc_id: string | null;
  drive_doc_name: string | null;
  status: ProjectStatus;
  start_date: string;
  end_date: string;
  assignee_ids: string[];   // team members assigned to this project
  created_at: string;
}

function serialize(doc: any): any {
  if (doc === null || doc === undefined) return doc;
  if (doc instanceof ObjectId) return doc.toHexString();
  if (doc instanceof Date) return doc.toISOString();
  if (Array.isArray(doc)) return doc.map(serialize);
  if (typeof doc === 'object') {
    const out: any = {};
    for (const [k, v] of Object.entries(doc)) out[k] = serialize(v);
    return out;
  }
  return doc;
}

async function pmProjectsCol() {
  const db = await getDb();
  return db.collection('pm_projects');
}

export async function getPmProjects(ownerId: string): Promise<PmProject[]> {
  const col = await pmProjectsCol();
  const docs = await col.find({ owner_id: new ObjectId(ownerId) }).sort({ created_at: -1 }).toArray();
  return docs.map(serialize) as PmProject[];
}

export async function getPmProject(id: string, ownerId: string): Promise<PmProject | null> {
  const col = await pmProjectsCol();
  const doc = await col.findOne({ _id: new ObjectId(id), owner_id: new ObjectId(ownerId) });
  return doc ? (serialize(doc) as PmProject) : null;
}

export async function createPmProject(
  ownerId: string,
  data: { name: string; drive_doc_id?: string | null; drive_doc_name?: string | null; status?: ProjectStatus; start_date: string; end_date: string; assignee_ids?: string[] }
): Promise<PmProject> {
  const col = await pmProjectsCol();
  const doc = {
    owner_id: new ObjectId(ownerId),
    name: data.name,
    drive_doc_id: data.drive_doc_id ?? null,
    drive_doc_name: data.drive_doc_name ?? null,
    status: data.status ?? 'planning',
    start_date: data.start_date,
    end_date: data.end_date,
    assignee_ids: data.assignee_ids ?? [],
    created_at: new Date().toISOString(),
  };
  const result = await col.insertOne(doc);
  return serialize({ ...doc, _id: result.insertedId }) as PmProject;
}

export async function updatePmProject(
  id: string,
  ownerId: string,
  data: Partial<{ name: string; drive_doc_id: string | null; drive_doc_name: string | null; status: ProjectStatus; start_date: string; end_date: string; assignee_ids: string[] }>
): Promise<PmProject | null> {
  const col = await pmProjectsCol();
  const result = await col.findOneAndUpdate(
    { _id: new ObjectId(id), owner_id: new ObjectId(ownerId) },
    { $set: data },
    { returnDocument: 'after' }
  );
  return result ? (serialize(result) as PmProject) : null;
}

export async function deletePmProject(id: string, ownerId: string): Promise<boolean> {
  const col = await pmProjectsCol();
  const result = await col.deleteOne({ _id: new ObjectId(id), owner_id: new ObjectId(ownerId) });
  return result.deletedCount > 0;
}
