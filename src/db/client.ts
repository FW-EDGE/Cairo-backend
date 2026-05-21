import { MongoClient, Db, Collection } from 'mongodb';
import { getConfig } from '../config.js';

let client: MongoClient | null = null;
let db: Db | null = null;

export async function getDb(): Promise<Db> {
  if (db) return db;

  const config = getConfig();
  const { uri, database } = config.mongodb;

  client = new MongoClient(uri, {
    tlsAllowInvalidCertificates: true,
    serverSelectionTimeoutMS: 10000,
    connectTimeoutMS: 10000,
    socketTimeoutMS: 45000,
  });

  // Prevent unhandled 'error' events from crashing the process
  client.on('error', (err) => {
    console.error('[MongoDB] Client error (handled):', err);
    client = null;
    db = null;
  });
  client.on('close', () => {
    console.warn('[MongoDB] Connection closed — will reconnect on next request');
    client = null;
    db = null;
  });

  await client.connect();
  db = client.db(database);
  console.log(`[MongoDB] Connected to ${database}`);
  return db;
}

export async function closeDb(): Promise<void> {
  if (client) {
    await client.close();
    client = null;
    db = null;
  }
}

export async function usersCol(): Promise<Collection> {
  const database = await getDb();
  return database.collection('users');
}

export async function driveCacheCol(): Promise<Collection> {
  const database = await getDb();
  return database.collection('drive_cache');
}

export async function oauthStatesCol(): Promise<Collection> {
  const database = await getDb();
  return database.collection('oauth_states');
}

export async function embeddingsCol(): Promise<Collection> {
  const database = await getDb();
  const config = getConfig();
  return database.collection(config.mongodb.collection);
}
