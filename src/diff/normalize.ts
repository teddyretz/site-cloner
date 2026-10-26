import type { JsonValue, NetworkExchange, RowChange } from "../observation/schema.ts";
import { stableStringify } from "../observation/normalize.ts";
import type { NormalizationProfile } from "./schema.ts";

const isoTimestamp = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g;
const uuid = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;

export function normalizeText(value: string, profile: NormalizationProfile): string {
  let normalized = value.replace(/\r\n/g, "\n").trim();
  if (profile.normalizeIsoTimestamps) normalized = normalized.replace(isoTimestamp, "[TIMESTAMP]");
  if (profile.normalizeUuids) normalized = normalized.replace(uuid, "[UUID]");
  for (const replacement of profile.uiTextReplacements) {
    normalized = normalized.split(replacement.from).join(replacement.to);
  }
  return normalized;
}

export function normalizeUrlForComparison(rawUrl: string, profile: NormalizationProfile): string {
  try {
    const url = new URL(rawUrl);
    const ignored = new Set(profile.ignoredQueryParameters.map((key) => key.toLowerCase()));
    const query = [...url.searchParams.entries()]
      .filter(([key]) => !ignored.has(key.toLowerCase()))
      .sort(([aKey, aValue], [bKey, bValue]) => aKey.localeCompare(bKey) || aValue.localeCompare(bValue));
    const search = new URLSearchParams(query).toString();
    return `${url.pathname}${search ? `?${search}` : ""}`;
  } catch {
    return rawUrl;
  }
}

export function normalizeJson(value: JsonValue | undefined, profile: NormalizationProfile): JsonValue | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return normalizeText(value, profile);
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((item) => normalizeJson(item, profile) as JsonValue);
  const ignored = new Set(profile.ignoredJsonKeys.map((key) => key.toLowerCase()));
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !ignored.has(key.toLowerCase()))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, normalizeJson(child, profile) as JsonValue]),
  );
}

export function canonicalNetworkExchange(exchange: NetworkExchange, profile: NormalizationProfile): JsonValue {
  return {
    method: exchange.method,
    url: normalizeUrlForComparison(exchange.url, profile),
    status: exchange.status ?? null,
    requestBody: normalizeJson(exchange.requestBody, profile) ?? null,
    responseBody: normalizeJson(exchange.responseBody, profile) ?? null,
    responseBodyOmitted: exchange.responseBodyOmitted ?? null,
    failure: exchange.failure ? normalizeText(exchange.failure, profile) : null,
  };
}

export function includeNetworkExchange(exchange: NetworkExchange, profile: NormalizationProfile): boolean {
  if (!profile.includedNetworkResourceTypes.includes(exchange.resourceType)) return false;
  return !profile.ignoredNetworkUrlPrefixes.some((prefix) => exchange.url.startsWith(prefix));
}

export function canonicalDatabaseChanges(changes: RowChange[], profile: NormalizationProfile): JsonValue {
  return changes
    .map((change) => {
      const ignoredColumns = new Set([
        ...profile.ignoredJsonKeys.map((key) => key.toLowerCase()),
        ...(profile.ignoredDatabaseColumns[change.table] ?? []).map((key) => key.toLowerCase()),
      ]);
      const normalizeRow = (row: Record<string, JsonValue> | undefined): JsonValue =>
        row
          ? Object.fromEntries(
              Object.entries(row)
                .filter(([key]) => !ignoredColumns.has(key.toLowerCase()))
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([key, value]) => [key, normalizeJson(value, profile) as JsonValue]),
            )
          : null;
      return {
        table: change.table,
        operation: change.operation,
        logicalIdentity: normalizeJson(change.logicalIdentity, profile) ?? null,
        before: normalizeRow(change.before),
        after: normalizeRow(change.after),
      };
    })
    .sort((a, b) => stableStringify(a).localeCompare(stableStringify(b)));
}
