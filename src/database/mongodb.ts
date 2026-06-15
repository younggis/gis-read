/**
 * MongoDB GeoJSON adapter.
 *
 * MongoDB has no tables — instead each "table" name in our options API is
 * interpreted as a Mongo collection (optionally qualified as `db.collection`).
 * Documents are stored in GeoJSON Feature shape so they can be consumed by any
 * GeoJSON-aware Mongo tool. No WKB round-trip is needed.
 */
import type { Feature, ParseResult } from '../types.js';
import { validateDatabaseIdentifier, normalizeTableName } from './naming.js';

const FEATURE_TYPE = 'Feature';

export interface MongoTarget {
  dbName?: string;
  collection: string;
}

/**
 * Resolve a "table" name into a Mongo database + collection pair.
 * Accepts either `collection` or `db.collection` form.
 * If `dbName` is provided, it overrides the qualifier in the input.
 */
export function parseMongoTarget(input: string, dbName?: string): MongoTarget {
  const parsed = normalizeTableName(input);
  return {
    dbName: dbName ?? parsed.schema,
    collection: parsed.table,
  };
}

/**
 * Extract a default database name from a Mongo URI of the form
 * `mongodb://host[:port]/<dbname>?...`. Returns undefined if absent.
 */
export function defaultDbNameFromUri(uri: string): string | undefined {
  try {
    const url = new URL(uri);
    const db = url.pathname.replace(/^\//, '').trim();
    if (!db) return undefined;
    // The default "admin" db is what drivers use when none is given; treat
    // it as "no explicit db" so callers can still override.
    if (db.toLowerCase() === 'admin') return undefined;
    validateDatabaseIdentifier(db);
    return db;
  } catch {
    return undefined;
  }
}

export async function importMongoCollection(
  uri: string,
  target: MongoTarget,
  features: Feature[],
): Promise<{ inserted: number }> {
  const { MongoClient } = await importOptionalMongo();
  const client = new MongoClient(uri);
  const { dbName, collection } = requireDbAndCollection(target);
  try {
    await client.connect();
    const coll = client.db(dbName).collection(collection);
    if (features.length === 0) return { inserted: 0 };
    const docs = features.map(featureToMongoDoc);
    const result = await coll.insertMany(docs, { ordered: false });
    return { inserted: result.insertedCount };
  } finally {
    await client.close();
  }
}

export async function exportMongoCollection(
  uri: string,
  target: MongoTarget,
): Promise<ParseResult> {
  const { MongoClient } = await importOptionalMongo();
  const client = new MongoClient(uri);
  const { dbName, collection } = requireDbAndCollection(target);
  try {
    await client.connect();
    const coll = client.db(dbName).collection(collection);
    const docs = await coll.find({}, { projection: { _id: 0 } }).toArray();
    const features: Feature[] = [];
    for (const doc of docs) {
      const f = mongoDocToFeature(doc);
      if (f) features.push(f);
    }
    return {
      name: collection,
      features,
      crs: { type: 'name', properties: { name: 'EPSG:4326' } },
      meta: { source: 'mongodb', db: dbName, collection },
    };
  } finally {
    await client.close();
  }
}

export async function dropMongoCollection(uri: string, target: MongoTarget): Promise<void> {
  const { MongoClient } = await importOptionalMongo();
  const client = new MongoClient(uri);
  const { dbName, collection } = requireDbAndCollection(target);
  try {
    await client.connect();
    await client.db(dbName).collection(collection).drop().catch((err: unknown) => {
      // Ignore "namespace not found" — collection simply did not exist.
      const message = err instanceof Error ? err.message : String(err);
      if (!/ns not found/i.test(message)) throw err;
    });
  } finally {
    await client.close();
  }
}

function requireDbAndCollection(target: MongoTarget): { dbName: string; collection: string } {
  if (!target.dbName) {
    throw new Error('MongoDB requires a database name. Pass --db-name or include it in the connection URI (mongodb://host:port/<db>).');
  }
  if (!target.collection) {
    throw new Error('MongoDB requires a collection name. Pass --table <collection> or db.collection.');
  }
  return { dbName: target.dbName, collection: target.collection };
}

function featureToMongoDoc(feature: Feature): Record<string, unknown> {
  const doc: Record<string, unknown> = {
    type: FEATURE_TYPE,
    properties: feature.properties ?? {},
  };
  if (feature.geometry) doc.geometry = feature.geometry;
  if (feature.id !== undefined) doc.id = feature.id;
  return doc;
}

function mongoDocToFeature(doc: unknown): Feature | null {
  if (!doc || typeof doc !== 'object') return null;
  const record = doc as Record<string, unknown>;
  const geometry = (record.geometry && typeof record.geometry === 'object')
    ? (record.geometry as Feature['geometry'])
    : null;
  const properties = (record.properties && typeof record.properties === 'object')
    ? (record.properties as Record<string, unknown>)
    : {};
  const id = record.id;
  return {
    type: FEATURE_TYPE,
    geometry,
    properties,
    ...(id !== undefined ? { id: id as string | number } : {}),
  } as Feature;
}

async function importOptionalMongo(): Promise<any> {
  try {
    return await import('mongodb');
  } catch (error) {
    if ((error as { code?: string }).code === 'ERR_MODULE_NOT_FOUND') {
      throw new Error('MongoDB support requires the "mongodb" package. Run npm install first.');
    }
    throw error;
  }
}
