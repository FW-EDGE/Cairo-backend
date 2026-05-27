import { Router, Request, Response } from 'express';
import { google, drive_v3 } from 'googleapis';
import { requireUser } from '../auth/middleware.js';
import { tokensToClient } from '../auth/google.js';
import { saveDriveCache, getDriveCache, DriveFile } from '../db/driveCache.js';

/** Returns the type key used by the frontend DriveFileType */
export function mimeToType(mime: string): string {
  const map: Record<string, string> = {
    'application/vnd.google-apps.folder':       'folder',
    'application/vnd.google-apps.document':     'doc',
    'application/vnd.google-apps.spreadsheet':  'sheet',
    'application/vnd.google-apps.presentation': 'slide',
    'application/vnd.google-apps.form':         'file',
    'application/vnd.google-apps.drawing':      'file',
    'application/vnd.google-apps.script':       'file',
    'application/vnd.google-apps.site':         'file',
    'application/pdf':  'pdf',
    'image/jpeg':       'image',
    'image/png':        'image',
    'image/gif':        'image',
    'image/webp':       'image',
    'video/mp4':        'file',
    'audio/mpeg':       'file',
    'text/plain':       'file',
    'text/html':        'file',
    'application/zip':  'file',
    'application/json': 'file',
  };
  return map[mime] ?? 'file';
}

function flattenForFrontend(nodes: DriveFile[], forceShared = false) {
  const result: Array<{ id: string; name: string; type: string; url: string; modified?: string; parents?: string[]; shared: boolean }> = [];
  function walk(node: DriveFile, isShared: boolean) {
    // "shared" in the frontend means "not owned by the user" (came from Shared With Me / Shared Drives).
    // We intentionally ignore node.shared (Google's "has been shared with others") here —
    // that flag is true for the user's own files they've shared, which should stay in My Drive.
    result.push({ id: node.id, name: node.name, type: node.type, url: node.webViewLink ?? '', modified: node.modifiedTime, parents: node.parents, shared: forceShared || isShared });
    for (const child of node.children ?? []) walk(child, forceShared || isShared);
  }
  for (const node of nodes) walk(node, forceShared);
  return result;
}

function googleFileToInternal(f: drive_v3.Schema$File): DriveFile {
  return { id: f.id ?? '', name: f.name ?? '', mimeType: f.mimeType ?? '', type: mimeToType(f.mimeType ?? ''), modifiedTime: f.modifiedTime ?? undefined, webViewLink: f.webViewLink ?? undefined, parents: f.parents ?? [], size: f.size ?? undefined, shared: f.shared ?? false };
}

const DRIVE_FIELDS = 'nextPageToken, files(id, name, mimeType, modifiedTime, webViewLink, parents, size, shared)';

async function listAllFiles(driveApi: drive_v3.Drive, query: string, extraParams?: Partial<drive_v3.Params$Resource$Files$List>): Promise<DriveFile[]> {
  const files: DriveFile[] = [];
  let pageToken: string | undefined;
  do {
    const res = await driveApi.files.list({ q: query, fields: DRIVE_FIELDS, pageSize: 1000, pageToken, ...extraParams });
    files.push(...(res.data.files ?? []).map(googleFileToInternal));
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  return files;
}

function buildTree(files: DriveFile[], rootParent?: string): DriveFile[] {
  const byId = new Map<string, DriveFile>();
  const rootFiles: DriveFile[] = [];
  for (const f of files) byId.set(f.id, { ...f, children: [] });
  for (const f of byId.values()) {
    const parent = f.parents?.[0];
    if (parent && byId.has(parent)) { byId.get(parent)!.children = byId.get(parent)!.children ?? []; byId.get(parent)!.children!.push(f); }
    else if (!rootParent || f.parents?.includes(rootParent)) rootFiles.push(f);
  }
  return rootFiles;
}

async function bfsMyDrive(driveApi: drive_v3.Drive): Promise<DriveFile[]> {
  const allFiles = await listAllFiles(driveApi, "trashed=false and 'me' in owners", { corpora: 'user' });
  const rootRes = await driveApi.files.get({ fileId: 'root', fields: 'id' });
  const rootId = rootRes.data.id ?? 'root';
  return buildTree(allFiles, rootId);
}

async function fetchFolderSubtree(driveApi: drive_v3.Drive, rootId: string, maxDepth = 6): Promise<DriveFile[]> {
  const allFiles: DriveFile[] = [];
  const queue: Array<{ id: string; depth: number }> = [{ id: rootId, depth: 0 }];
  const visited = new Set<string>([rootId]);
  while (queue.length > 0) {
    const { id, depth } = queue.shift()!;
    if (depth >= maxDepth) continue;
    const children = await listAllFiles(driveApi, `'${id}' in parents and trashed=false`, { includeItemsFromAllDrives: true, supportsAllDrives: true });
    allFiles.push(...children);
    for (const child of children) {
      if (child.type === 'folder' && !visited.has(child.id)) { visited.add(child.id); queue.push({ id: child.id, depth: depth + 1 }); }
    }
  }
  return buildTree(allFiles, rootId);
}

async function fetchSharedWithMe(driveApi: drive_v3.Drive): Promise<DriveFile> {
  const topLevel = await listAllFiles(driveApi, 'sharedWithMe=true and trashed=false', { corpora: 'user' });
  await Promise.all(topLevel.filter((f) => f.type === 'folder').map(async (folder) => {
    folder.children = await fetchFolderSubtree(driveApi, folder.id).catch((err) => { console.error(`[Drive] fetchFolderSubtree failed for ${folder.id}:`, err); return []; });
  }));
  return { id: '__shared_with_me__', name: 'Compartidos conmigo', mimeType: 'application/vnd.google-apps.folder', type: 'folder', shared: true, children: topLevel.map((f) => ({ ...f, shared: true })) };
}

async function bfsDriveById(driveApi: drive_v3.Drive, driveId: string): Promise<DriveFile[]> {
  const allFiles = await listAllFiles(driveApi, 'trashed=false', { corpora: 'drive', driveId, includeItemsFromAllDrives: true, supportsAllDrives: true });
  return buildTree(allFiles);
}

async function bfsSharedDrives(driveApi: drive_v3.Drive): Promise<DriveFile[]> {
  const result: DriveFile[] = [];
  let pageToken: string | undefined;
  const sharedDrives: Array<{ id: string; name: string }> = [];
  do {
    const res = await driveApi.drives.list({ pageSize: 100, pageToken, fields: 'nextPageToken, drives(id, name)' });
    sharedDrives.push(...(res.data.drives ?? []).map((d) => ({ id: d.id!, name: d.name! })));
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  for (const sd of sharedDrives) {
    try {
      const sdFiles = await bfsDriveById(driveApi, sd.id);
      result.push({ id: sd.id, name: sd.name, mimeType: 'application/vnd.google-apps.folder', type: 'folder', children: sdFiles });
    } catch (err) { console.error(`[Drive] Failed to BFS shared drive ${sd.id}:`, err); }
  }
  return result;
}

const router = Router();

// GET /drive/cached
router.get('/drive/cached', requireUser, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const cached = await getDriveCache(user._id);
    if (!cached) { res.json({ mydrive: [], shared: [], files: [], fetched_at: null }); return; }
    const files = [...flattenForFrontend(cached.mydrive, false), ...flattenForFrontend(cached.shared, true)];
    res.json({ ...cached, files });
  } catch (err) {
    console.error('[Drive] GET /drive/cached error:', err);
    res.status(500).json({ error: 'Failed to fetch drive cache' });
  }
});

// POST /drive/refresh
router.post('/drive/refresh', requireUser, async (req: Request, res: Response) => {
  const user = req.user!;
  if (!user.google_tokens) { res.status(403).json({ error: 'Google account not connected' }); return; }

  setImmediate(async () => {
    try {
      const authClient = tokensToClient(user.google_tokens!, user._id);
      const driveApi = google.drive({ version: 'v3', auth: authClient });
      const [mydrive, sharedDrives, sharedWithMe] = await Promise.all([
        bfsMyDrive(driveApi).catch(() => [] as DriveFile[]),
        bfsSharedDrives(driveApi).catch(() => [] as DriveFile[]),
        fetchSharedWithMe(driveApi).catch(() => ({ id: '__shared_with_me__', name: 'Compartidos conmigo', mimeType: 'application/vnd.google-apps.folder', type: 'folder', shared: true, children: [] } as DriveFile)),
      ]);
      await saveDriveCache(user._id, mydrive, [sharedWithMe, ...sharedDrives]);
      console.log(`[Drive] Background refresh complete for user ${user._id}`);
    } catch (err) { console.error('[Drive] Background refresh error:', err); }
  });

  res.json({ ok: true, message: 'Drive refresh started in background' });
});

export default router;
