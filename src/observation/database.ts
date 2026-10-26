import {
  databaseSnapshotSchema,
  type DatabaseAdapter,
  type DatabaseSnapshot,
  type JsonValue,
  type RowChange,
} from "./schema.ts";
import { redactJson, stableStringify } from "./normalize.ts";

type Row = Record<string, JsonValue>;

type FetchDatabaseSnapshotOptions = {
  url?: string;
  allowedOrigins: string[];
  maxBytes: number;
  maxRowsPerTable: number;
  runId: string;
  correlationId?: string;
};

function identityFrom(row: Row, keys: string[], table: string, kind: string): Record<string, JsonValue> {
  return Object.fromEntries(
    keys.map((key) => {
      if (row[key] === undefined) throw new Error(`${table} row is missing ${kind} key column ${key}`);
      return [key, row[key]];
    }),
  );
}

function rowMatchesScope(row: Row, scope: Record<string, JsonValue>): boolean {
  return Object.entries(scope).every(([key, expected]) => stableStringify(row[key]) === stableStringify(expected));
}

function indexRows(rows: Row[], keys: string[], table: string): Map<string, Row> {
  const indexed = new Map<string, Row>();
  for (const row of rows) {
    const serialized = stableStringify(identityFrom(row, keys, table, "primary"));
    if (indexed.has(serialized)) throw new Error(`${table} contains duplicate configured primary identity ${serialized}`);
    indexed.set(serialized, row);
  }
  return indexed;
}

export function diffDatabase(
  before: DatabaseSnapshot | undefined,
  after: DatabaseSnapshot | undefined,
  adapter: DatabaseAdapter | undefined,
): RowChange[] {
  if (!before || !after) return [];
  if (!adapter) throw new Error("Database evidence requires an explicit database adapter");
  const changes: RowChange[] = [];
  const tables = new Set([...Object.keys(before.tables), ...Object.keys(after.tables)]);

  for (const table of [...tables].sort()) {
    const tableAdapter = adapter.tables[table];
    const unscopedBefore = before.tables[table] ?? [];
    const unscopedAfter = after.tables[table] ?? [];
    if (!tableAdapter) {
      if (unscopedBefore.length || unscopedAfter.length) {
        throw new Error(`Database adapter has no identity metadata for table ${table}`);
      }
      continue;
    }
    const beforeRows = indexRows(
      unscopedBefore.filter((row) => rowMatchesScope(row, tableAdapter.scope)),
      tableAdapter.primaryKey,
      table,
    );
    const afterRows = indexRows(
      unscopedAfter.filter((row) => rowMatchesScope(row, tableAdapter.scope)),
      tableAdapter.primaryKey,
      table,
    );
    const identities = new Set([...beforeRows.keys(), ...afterRows.keys()]);

    for (const identityKey of [...identities].sort()) {
      const previous = beforeRows.get(identityKey);
      const current = afterRows.get(identityKey);
      const row = current ?? previous;
      if (!row) continue;
      const primaryIdentity = identityFrom(row, tableAdapter.primaryKey, table, "primary");
      const logicalIdentity = tableAdapter.logicalKey
        ? identityFrom(row, tableAdapter.logicalKey, table, "logical")
        : undefined;
      if (!previous && current) {
        changes.push({ table, operation: "insert", primaryIdentity, logicalIdentity, after: current });
      } else if (previous && !current) {
        changes.push({ table, operation: "delete", primaryIdentity, logicalIdentity, before: previous });
      } else if (previous && current && stableStringify(previous) !== stableStringify(current)) {
        changes.push({
          table,
          operation: "update",
          primaryIdentity,
          logicalIdentity,
          before: previous,
          after: current,
        });
      }
    }
  }

  return changes;
}

export async function fetchDatabaseSnapshot(
  options: FetchDatabaseSnapshotOptions,
): Promise<DatabaseSnapshot | undefined> {
  if (!options.url) return undefined;
  const url = new URL(options.url);
  const allowedOrigins = new Set(options.allowedOrigins.map((origin) => new URL(origin).origin));
  if (!allowedOrigins.has(url.origin)) throw new Error(`Database snapshot origin is outside policy: ${url.origin}`);
  const headers: Record<string, string> = {
    accept: "application/json",
    "x-replicator-run-id": options.runId,
  };
  if (options.correlationId) headers["x-replicator-step-id"] = options.correlationId;
  const response = await fetch(url, { headers, redirect: "error" });
  if (!response.ok) throw new Error(`Database snapshot endpoint returned ${response.status}`);
  const text = await readTextBounded(response, options.maxBytes);
  const parsed = databaseSnapshotSchema.parse(JSON.parse(text));
  for (const [table, rows] of Object.entries(parsed.tables)) {
    if (rows.length > options.maxRowsPerTable) {
      throw new Error(`${table} exceeded the database row limit of ${options.maxRowsPerTable}`);
    }
  }
  return databaseSnapshotSchema.parse(redactJson(parsed));
}

async function readTextBounded(response: Response, maxBytes: number): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (declaredLength > maxBytes) throw new Error(`Database snapshot exceeded ${maxBytes} bytes`);
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`Database snapshot exceeded ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}
