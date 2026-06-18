import { ObjectId } from 'mongodb';
import { getDb } from './client.js';

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'blocked';

export interface PmTask {
  _id: string;
  project_id: string;
  owner_id: string;
  name: string;
  description: string;
  required_skills: string[];
  estimated_hours: number;
  start_date: string;
  end_date: string;
  assignee_id: string | null;
  dependencies: string[];
  status: TaskStatus;
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

async function pmTasksCol() {
  const db = await getDb();
  return db.collection('pm_tasks');
}

export async function getTasksByProject(projectId: string): Promise<PmTask[]> {
  const col = await pmTasksCol();
  const docs = await col.find({ project_id: projectId }).sort({ created_at: 1 }).toArray();
  return docs.map(serialize) as PmTask[];
}

export async function getTasksByAssignee(assigneeId: string, ownerId: string): Promise<PmTask[]> {
  const col = await pmTasksCol();
  const docs = await col.find({ assignee_id: assigneeId, owner_id: new ObjectId(ownerId) }).toArray();
  return docs.map(serialize) as PmTask[];
}

export async function getPmTask(id: string): Promise<PmTask | null> {
  const col = await pmTasksCol();
  const doc = await col.findOne({ _id: new ObjectId(id) });
  return doc ? (serialize(doc) as PmTask) : null;
}

export async function createPmTask(
  projectId: string,
  ownerId: string,
  data: {
    name: string;
    description?: string;
    required_skills?: string[];
    estimated_hours?: number;
    start_date?: string;
    end_date?: string;
    assignee_id?: string | null;
    dependencies?: string[];
    status?: TaskStatus;
  }
): Promise<PmTask> {
  const col = await pmTasksCol();
  const doc = {
    project_id: projectId,
    owner_id: new ObjectId(ownerId),
    name: data.name,
    description: data.description ?? '',
    required_skills: data.required_skills ?? [],
    estimated_hours: data.estimated_hours ?? 8,
    start_date: data.start_date ?? new Date().toISOString(),
    end_date: data.end_date ?? new Date().toISOString(),
    assignee_id: data.assignee_id ?? null,
    dependencies: data.dependencies ?? [],
    status: data.status ?? 'pending',
    created_at: new Date().toISOString(),
  };
  const result = await col.insertOne(doc);
  return serialize({ ...doc, _id: result.insertedId }) as PmTask;
}

export async function updatePmTask(
  id: string,
  data: Partial<{
    name: string;
    description: string;
    required_skills: string[];
    estimated_hours: number;
    start_date: string;
    end_date: string;
    assignee_id: string | null;
    dependencies: string[];
    status: TaskStatus;
  }>
): Promise<PmTask | null> {
  const col = await pmTasksCol();
  const result = await col.findOneAndUpdate(
    { _id: new ObjectId(id) },
    { $set: data },
    { returnDocument: 'after' }
  );
  return result ? (serialize(result) as PmTask) : null;
}

export async function deletePmTask(id: string): Promise<boolean> {
  const col = await pmTasksCol();
  const result = await col.deleteOne({ _id: new ObjectId(id) });
  return result.deletedCount > 0;
}

export async function deleteTasksByProject(projectId: string): Promise<void> {
  const col = await pmTasksCol();
  await col.deleteMany({ project_id: projectId });
}
