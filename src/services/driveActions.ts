import { google, drive_v3 } from 'googleapis';
import { tokensToClient } from '../auth/google.js';
import { GoogleTokens } from '../db/users.js';

export async function createDriveFolder(
  userId: string,
  tokens: GoogleTokens,
  folderName: string,
  parentId: string
): Promise<string> {
  const auth = tokensToClient(tokens, userId);
  const drive = google.drive({ version: 'v3', auth });

  const res = await drive.files.create({
    requestBody: {
      name: folderName,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId],
    },
    fields: 'id',
  });
  return res.data.id!;
}

export async function copyDriveFile(
  userId: string,
  tokens: GoogleTokens,
  fileId: string,
  newName: string,
  parentFolderId: string
): Promise<string> {
  const auth = tokensToClient(tokens, userId);
  const drive = google.drive({ version: 'v3', auth });

  const res = await drive.files.copy({
    fileId,
    requestBody: {
      name: newName,
      parents: [parentFolderId],
    },
    fields: 'id',
  });
  return res.data.id!;
}

export async function searchDriveFiles(
  userId: string,
  tokens: GoogleTokens,
  query: string
): Promise<drive_v3.Schema$File[]> {
  const auth = tokensToClient(tokens, userId);
  const drive = google.drive({ version: 'v3', auth });

  const res = await drive.files.list({
    q: query,
    fields: 'files(id, name, mimeType)',
  });
  return res.data.files || [];
}

export async function getFileContent(
  userId: string,
  tokens: GoogleTokens,
  fileId: string
): Promise<string> {
  const auth = tokensToClient(tokens, userId);
  const drive = google.drive({ version: 'v3', auth });

  // Check mimeType first
  const meta = await drive.files.get({ fileId, fields: 'mimeType' });
  const mimeType = meta.data.mimeType;

  if (mimeType === 'application/vnd.google-apps.document') {
    const res = await drive.files.export({
      fileId,
      mimeType: 'text/plain',
    });
    return res.data as string;
  } else {
    const res = await drive.files.get({
      fileId,
      alt: 'media',
    });
    return res.data as string;
  }
}

export async function updateFileContent(
  userId: string,
  tokens: GoogleTokens,
  fileId: string,
  content: string
): Promise<void> {
  const auth = tokensToClient(tokens, userId);
  const drive = google.drive({ version: 'v3', auth });
  const docs = google.docs({ version: 'v1', auth });

  const fileMeta = await drive.files.get({ fileId, fields: 'mimeType' });
  const mimeType = fileMeta.data.mimeType;

  if (mimeType === 'application/vnd.google-apps.document') {
    await docs.documents.batchUpdate({
      documentId: fileId,
      requestBody: {
        requests: [{ insertText: { location: { index: 1 }, text: content } }],
      },
    });
  } else {
    await drive.files.update({
      fileId,
      media: { mimeType: 'text/plain', body: content },
    });
  }
}
