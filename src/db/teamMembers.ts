import { ObjectId } from 'mongodb';
import { getDb } from './client.js';

export interface TeamMember {
  _id: string;
  owner_id: string;
  name: string;
  email: string;
  role: string;
  skills: string[];
  capacity_hours_per_day: number;
  avatar_color: string;
  created_at: string;
}

const AVATAR_COLORS = [
  '#06b6d4', '#8b5cf6', '#f59e0b', '#10b981',
  '#ef4444', '#3b82f6', '#ec4899', '#14b8a6',
];

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

async function teamMembersCol() {
  const db = await getDb();
  return db.collection('team_members');
}

export async function getTeamMembers(ownerId: string): Promise<TeamMember[]> {
  const col = await teamMembersCol();
  const docs = await col.find({ owner_id: new ObjectId(ownerId) }).sort({ created_at: 1 }).toArray();
  return docs.map(serialize) as TeamMember[];
}

export async function getTeamMemberById(id: string, ownerId: string): Promise<TeamMember | null> {
  const col = await teamMembersCol();
  const doc = await col.findOne({ _id: new ObjectId(id), owner_id: new ObjectId(ownerId) });
  return doc ? (serialize(doc) as TeamMember) : null;
}

export async function createTeamMember(
  ownerId: string,
  data: { name: string; email: string; role: string; skills: string[]; capacity_hours_per_day?: number }
): Promise<TeamMember> {
  const col = await teamMembersCol();
  const count = await col.countDocuments({ owner_id: new ObjectId(ownerId) });
  const avatar_color = AVATAR_COLORS[count % AVATAR_COLORS.length];

  const doc = {
    owner_id: new ObjectId(ownerId),
    name: data.name,
    email: data.email,
    role: data.role,
    skills: data.skills ?? [],
    capacity_hours_per_day: data.capacity_hours_per_day ?? 8,
    avatar_color,
    created_at: new Date().toISOString(),
  };

  const result = await col.insertOne(doc);
  return serialize({ ...doc, _id: result.insertedId }) as TeamMember;
}

export async function updateTeamMember(
  id: string,
  ownerId: string,
  data: Partial<{ name: string; email: string; role: string; skills: string[]; capacity_hours_per_day: number }>
): Promise<TeamMember | null> {
  const col = await teamMembersCol();
  const result = await col.findOneAndUpdate(
    { _id: new ObjectId(id), owner_id: new ObjectId(ownerId) },
    { $set: data },
    { returnDocument: 'after' }
  );
  return result ? (serialize(result) as TeamMember) : null;
}

export async function deleteTeamMember(id: string, ownerId: string): Promise<boolean> {
  const col = await teamMembersCol();
  const result = await col.deleteOne({ _id: new ObjectId(id), owner_id: new ObjectId(ownerId) });
  return result.deletedCount > 0;
}
