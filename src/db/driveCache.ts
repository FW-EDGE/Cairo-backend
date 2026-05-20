import { ObjectId } from 'mongodb';
import { driveCacheCol } from './client.js';
import { serialize } from './users.js';

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  type: string;
  modifiedTime?: string;
  webViewLink?: string;
  parents?: string[];
  size?: string;
  shared?: boolean;
  children?: DriveFile[];
}

export interface DriveCacheDoc {
  mydrive: DriveFile[];
  shared: DriveFile[];
  fetched_at: string;
}

export async function saveDriveCache(
  userId: string,
  mydrive: DriveFile[],
  shared: DriveFile[]
): Promise<void> {
  const col = await driveCacheCol();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);

  await col.updateOne(
    { user_id: new ObjectId(userId) },
    {
      $set: {
        user_id: new ObjectId(userId),
        mydrive,
        shared,
        fetched_at: now.toISOString(),
        expires_at: expiresAt,
      },
    },
    { upsert: true }
  );
}

export async function getDriveCache(userId: string): Promise<DriveCacheDoc | null> {
  const col = await driveCacheCol();
  const doc = await col.findOne({ user_id: new ObjectId(userId) });
  if (!doc) return null;

  return {
    mydrive: serialize(doc.mydrive) as DriveFile[],
    shared: serialize(doc.shared) as DriveFile[],
    fetched_at: doc.fetched_at as string,
  };
}
