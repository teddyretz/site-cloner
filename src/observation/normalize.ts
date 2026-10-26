import { createHash } from "node:crypto";
import type { JsonValue } from "./schema.ts";

export const REDACTED = "[REDACTED]";

const sensitiveKeyPattern = /(^|[-_])(authorization|cookie|password|passwd|secret|token|api[-_]?key|session|credential|cvv|ssn|oauth[-_]?code|signature|sig)($|[-_])/i;
const allowedHeaders = new Set([
  "accept",
  "cache-control",
  "content-length",
  "content-type",
  "etag",
  "if-none-match",
  "location",
  "x-request-id",
  "x-replicator-run-id",
  "x-replicator-step-id",
]);

export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers)
      .map(([key, value]) => [key.toLowerCase(), value] as const)
      .filter(([key]) => allowedHeaders.has(key))
      .map(([key, value]) => [key, isSensitiveKey(key) ? REDACTED : key === "location" ? redactUrl(value) : value]),
  );
}

export function redactJson(value: unknown, key = ""): JsonValue {
  if (isSensitiveKey(key)) return REDACTED;
  if (value === undefined) return null;
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => redactJson(item));
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, childValue]) => childValue !== undefined)
        .map(([childKey, childValue]) => [childKey, redactJson(childValue, childKey)]),
    );
  }
  return String(value);
}

export function redactUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    if (url.username) url.username = REDACTED;
    if (url.password) url.password = REDACTED;
    for (const key of [...url.searchParams.keys()]) {
      if (isSensitiveKey(key) || /^(code|state|x-amz-signature|x-goog-signature)$/i.test(key)) {
        url.searchParams.set(key, REDACTED);
      }
    }
    url.pathname = url.pathname.replace(
      /\/(token|secret|session|credential|signature|code)\/[^/]+/gi,
      (_match, label: string) => `/${label}/${encodeURIComponent(REDACTED)}`,
    );
    if (url.hash) url.hash = REDACTED;
    return url.toString();
  } catch {
    return rawUrl;
  }
}

export function parseAndRedactBody(body: string | null): JsonValue | undefined {
  if (!body) return undefined;
  try {
    return redactJson(JSON.parse(body));
  } catch {
    if (/^[^=&]+=[^&]*/.test(body)) {
      return redactJson(Object.fromEntries(new URLSearchParams(body)));
    }
    const safeBody = redactText(body);
    if (safeBody.length > 16_384) return `${safeBody.slice(0, 16_384)}…[TRUNCATED]`;
    return safeBody;
  }
}

export function redactText(value: string): string {
  const redacted = value
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, `$1${REDACTED}`)
    .replace(/\b(password|passwd|secret|token|api[-_]?key|session|credential|signature|code)\s*[:=]\s*["']?([^\s"'&,;}]+)/gi, `$1=${REDACTED}`);
  try {
    return JSON.stringify(redactJson(JSON.parse(redacted)));
  } catch {
    return redacted;
  }
}

export function sanitizeHtml(html: string): string {
  return html
    .replace(/<input\b[^>]*>/gi, (tag) => {
      const sensitive = /type=["']password["']/i.test(tag) || /(?:name|id|autocomplete)=["'][^"']*(?:password|secret|token|credential|cc-)[^"']*["']/i.test(tag);
      return sensitive ? tag.replace(/\bvalue=["'][^"']*["']/i, `value="${REDACTED}"`) : tag;
    })
    .replace(/(<textarea\b[^>]*(?:password|secret|token|credential)[^>]*>)[\s\S]*?(<\/textarea>)/gi, `$1${REDACTED}$2`)
    .replace(/(\b(?:authorization|token|password|secret|session|credential|api[-_]?key)=["'])[^"']*(["'])/gi, `$1${REDACTED}$2`);
}

export function isSensitiveKey(key: string): boolean {
  const normalized = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[.\s]/g, "_").toLowerCase();
  return sensitiveKeyPattern.test(normalized);
}

export function stableHash(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
