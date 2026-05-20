import { MongoClient, Db, Collection } from 'mongodb';
import { getConfig } from '../config.js';

let client: MongoClient | null = null;
let db: Db | null = null;

export async function getDb(): Promise<Db> {
  if (db) return db;

  const config = getConfig();
  const { uri, database } = config.mongodb;

  client = new MongoClient(uri, {
    // Atlas TLS certs can fail verification on Windows (UNABLE_TO_VERIFY_LEAF_SIGNATURE)
    // when the intermediate CA is missing from the local trust store.
    tlsAllowInvalidCertificates: true,
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
