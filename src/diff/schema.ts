import { z } from "zod";
import { jsonValueSchema } from "../observation/schema.ts";

export const COMPARISON_SCHEMA_VERSION = "0.1.0";

export const normalizationProfileSchema = z.object({
  profileVersion: z.literal("1"),
  ignoredJsonKeys: z
    .array(z.string().min(1).max(200))
    .max(200)
    .default(["id", "uuid", "createdAt", "updatedAt", "requestId", "traceId"]),
  ignoredQueryParameters: z
    .array(z.string().min(1).max(200))
    .max(200)
    .default(["_", "cacheBust", "requestId", "traceId"]),
  ignoredDatabaseColumns: z.record(z.string(), z.array(z.string().min(1).max(200)).max(200)).default({}),
  includedNetworkResourceTypes: z.array(z.string().min(1).max(50)).max(20).default(["xhr", "fetch"]),
  ignoredNetworkUrlPrefixes: z.array(z.string().max(2_000)).max(100).default([]),
  uiTextReplacements: z
    .array(z.object({ from: z.string().min(1).max(500), to: z.string().max(500) }))
    .max(100)
    .default([]),
  normalizeIsoTimestamps: z.boolean().default(true),
  normalizeUuids: z.boolean().default(true),
});

export type NormalizationProfile = z.infer<typeof normalizationProfileSchema>;

export const differenceSchema = z.object({
  id: z.string(),
  stepIndex: z.number().int(),
  layer: z.enum(["workflow", "ui", "api", "data"]),
  classification: z.enum(["noise", "cosmetic", "behavioral", "data", "unresolved"]),
  path: z.string(),
  summary: z.string(),
  expected: jsonValueSchema.optional(),
  actual: jsonValueSchema.optional(),
});

export type Difference = z.infer<typeof differenceSchema>;

export const comparisonReportSchema = z.object({
  schemaVersion: z.literal(COMPARISON_SCHEMA_VERSION),
  comparisonId: z.string(),
  createdAt: z.string(),
  source: z.object({ runId: z.string(), workflow: z.string(), url: z.string() }),
  replica: z.object({ runId: z.string(), workflow: z.string(), url: z.string() }),
  normalization: normalizationProfileSchema,
  normalizationDigest: z.string(),
  parityScore: z.number().min(0).max(1),
  checks: z.object({ total: z.number().int().nonnegative(), matched: z.number().int().nonnegative() }),
  counts: z.object({
    differences: z.number().int().nonnegative(),
    byLayer: z.record(z.string(), z.number().int().nonnegative()),
    byClassification: z.record(z.string(), z.number().int().nonnegative()),
  }),
  steps: z.array(
    z.object({
      index: z.number().int().nonnegative(),
      status: z.enum(["matched", "different", "missing"]),
      differenceIds: z.array(z.string()),
    }),
  ),
  differences: z.array(differenceSchema),
});

export type ComparisonReport = z.infer<typeof comparisonReportSchema>;
