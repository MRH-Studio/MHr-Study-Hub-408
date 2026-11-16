import { MongoClient } from 'mongodb';

const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB_NAME;

// Keep this application's client isolated and reject a cached client created
// with a different URI (for example, after runtime configuration changes).
const globalWithMongo = globalThis;
const cacheKey = '__mrhStudyHubMongo';
let cached = globalWithMongo[cacheKey];

if (!cached || cached.uri !== uri) {
  cached = globalWithMongo[cacheKey] = {
    uri,
    client: null,
    promise: null,
  };
}

const mongoOptions = {
  serverSelectionTimeoutMS: 10000,
  connectTimeoutMS: 10000,
  socketTimeoutMS: 10000,
  maxPoolSize: 5,
  autoSelectFamily: false,
};

export async function getMongoClient() {
  if (!uri) {
    throw new Error('MongoDB is not configured. Add MONGODB_URI to your environment variables.');
  }

  if (!cached.client) {
    cached.promise ??= new MongoClient(uri, mongoOptions).connect();
    try {
      cached.client = await cached.promise;
    } catch (error) {
      cached.promise = null;
      throw error;
    }
  }

  return cached.client;
}

export async function getDb() {
  if (!dbName) {
    throw new Error('MONGODB_DB_NAME is missing.');
  }

  const client = await getMongoClient();
  const db = client.db(dbName);

  // Never log the URI or credentials.
  if (process.env.NODE_ENV !== 'production') {
    console.info('[MongoDB] Connected database:', db.databaseName);
  }

  return db;
}
