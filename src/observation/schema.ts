import { z } from "zod";

export const TRACE_SCHEMA_VERSION = "0.2.0";

const jsonPrimitiveSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([jsonPrimitiveSchema, z.array(jsonValueSchema), z.record(z.string(), jsonValueSchema)]),
);

export const semanticLocatorSchema = z.object({
  role: z.string().max(80).optional(),
  name: z.string().max(500).optional(),
  label: z.string().max(500).optional(),
  testId: z.string().max(500).optional(),
  css: z.string().max(500).optional(),
});

export type SemanticLocator = z.infer<typeof semanticLocatorSchema>;

export const actionRiskSchema = z.enum(["read", "write", "external", "destructive"]);
export type ActionRisk = z.infer<typeof actionRiskSchema>;

export const recordedActionSchema = z.object({
  kind: z.enum([
    "navigate",
    "click",
    "fill",
    "select",
    "check",
    "uncheck",
    "press",
    "submit",
    "upload",
    "history",
    "popup",
  ]),
  target: semanticLocatorSchema.optional(),
  value: z.string().max(16_384).optional(),
  key: z.string().max(100).optional(),
  url: z.string().max(4_096).optional(),
  intent: z.string().max(1_000).optional(),
  risk: actionRiskSchema.optional(),
});

export type RecordedAction = z.infer<typeof recordedActionSchema>;

export const settlementRuleSchema = z.object({
  timeoutMs: z.number().int().min(250).max(120_000).default(10_000),
  minimumObservationMs: z.number().int().min(0).max(30_000).default(300),
  quietWindowMs: z.number().int().min(50).max(10_000).default(300),
  databasePollIntervalMs: z.number().int().min(50).max(5_000).default(150),
  databaseStablePolls: z.number().int().min(1).max(20).default(2),
});

export type SettlementRule = z.infer<typeof settlementRuleSchema>;

export const capturePolicySchema = z.object({
  policyVersion: z.literal("1"),
  dataMode: z.literal("test-data-only"),
  tenant: z.string().min(1).max(200),
  identity: z.string().min(1).max(200),
  allowedOrigins: z.array(z.string().url()).min(1).max(50),
  databaseOrigins: z.array(z.string().url()).max(20).default([]),
  maxActionRisk: actionRiskSchema.default("write"),
  injectCorrelationHeaders: z.boolean().default(false),
  screenshots: z.boolean().default(true),
  rawTrace: z.boolean().default(false),
  maskSelectors: z.array(z.string().min(1).max(500)).max(100).default([
    "input[type=password]",
    "input[autocomplete*=cc-]",
    "[data-sensitive]",
  ]),
  limits: z.object({
    responseBodyBytes: z.number().int().min(0).max(10 * 1024 * 1024).default(64 * 1024),
    databaseSnapshotBytes: z.number().int().min(1_024).max(100 * 1024 * 1024).default(5 * 1024 * 1024),
    databaseRowsPerTable: z.number().int().min(1).max(100_000).default(10_000),
    manualEvents: z.number().int().min(1).max(100_000).default(10_000),
    artifactBytes: z.number().int().min(1_024).max(500 * 1024 * 1024).default(50 * 1024 * 1024),
  }),
  settlement: settlementRuleSchema,
});

export type CapturePolicy = z.infer<typeof capturePolicySchema>;

export const databaseTableAdapterSchema = z.object({
  primaryKey: z.array(z.string().min(1)).min(1),
  logicalKey: z.array(z.string().min(1)).min(1).optional(),
  scope: z.record(z.string(), jsonValueSchema).default({}),
});

export const databaseAdapterSchema = z.object({
  adapterVersion: z.literal("1"),
  tables: z.record(z.string(), databaseTableAdapterSchema),
});

export type DatabaseAdapter = z.infer<typeof databaseAdapterSchema>;

export const pageSnapshotSchema = z.object({
  id: z.string(),
  capturedAt: z.string(),
  url: z.string(),
  title: z.string(),
  visibleText: z.string(),
  aria: z.string(),
  domPath: z.string(),
  screenshotPath: z.string().optional(),
});

export type PageSnapshot = z.infer<typeof pageSnapshotSchema>;

export const networkExchangeSchema = z.object({
  id: z.string(),
  startedAt: z.string(),
  completedAt: z.string().optional(),
  correlationId: z.string().optional(),
  method: z.string(),
  url: z.string(),
  resourceType: z.string(),
  requestHeaders: z.record(z.string(), z.string()),
  requestBody: jsonValueSchema.optional(),
  status: z.number().optional(),
  responseHeaders: z.record(z.string(), z.string()).optional(),
  responseBody: jsonValueSchema.optional(),
  responseBodyOmitted: z.enum(["not-text", "unknown-size", "too-large", "unavailable"]).optional(),
  failure: z.string().optional(),
});

export type NetworkExchange = z.infer<typeof networkExchangeSchema>;

export const consoleEntrySchema = z.object({
  id: z.string(),
  capturedAt: z.string(),
  level: z.string(),
  text: z.string(),
});

export type ConsoleEntry = z.infer<typeof consoleEntrySchema>;

export const databaseSnapshotSchema = z.object({
  tables: z.record(z.string(), z.array(z.record(z.string(), jsonValueSchema))),
});

export type DatabaseSnapshot = z.infer<typeof databaseSnapshotSchema>;

export const rowChangeSchema = z.object({
  table: z.string(),
  operation: z.enum(["insert", "update", "delete"]),
  primaryIdentity: z.record(z.string(), jsonValueSchema),
  logicalIdentity: z.record(z.string(), jsonValueSchema).optional(),
  before: z.record(z.string(), jsonValueSchema).optional(),
  after: z.record(z.string(), jsonValueSchema).optional(),
});

export type RowChange = z.infer<typeof rowChangeSchema>;

export const settlementResultSchema = z.object({
  status: z.enum(["settled", "timed-out"]),
  startedAt: z.string(),
  completedAt: z.string(),
  durationMs: z.number().int().nonnegative(),
  outstandingRequests: z.number().int().nonnegative(),
  databaseStablePolls: z.number().int().nonnegative(),
});

export type SettlementResult = z.infer<typeof settlementResultSchema>;

export const manualEventSchema = z.object({
  sequence: z.number().int().positive(),
  capturedAt: z.string(),
  monotonicMs: z.number().nonnegative(),
  pageId: z.string(),
  action: recordedActionSchema,
});

export type ManualEvent = z.infer<typeof manualEventSchema>;

export const recordedStepSchema = z.object({
  index: z.number().int().nonnegative(),
  correlationId: z.string(),
  startedAt: z.string(),
  completedAt: z.string(),
  actions: z.array(recordedActionSchema).min(1),
  manualEventRange: z
    .object({ firstSequence: z.number().int().positive(), lastSequence: z.number().int().positive() })
    .optional(),
  settlement: settlementResultSchema,
  beforeSnapshotId: z.string(),
  afterSnapshotId: z.string(),
  networkExchangeIds: z.array(z.string()),
  consoleEntryIds: z.array(z.string()),
  databaseChanges: z.array(rowChangeSchema),
});

export type RecordedStep = z.infer<typeof recordedStepSchema>;

export const recordingManifestSchema = z.object({
  schemaVersion: z.literal(TRACE_SCHEMA_VERSION),
  runId: z.string(),
  workflow: z.string(),
  sourceUrl: z.string(),
  startedAt: z.string(),
  completedAt: z.string(),
  policy: capturePolicySchema,
  policyDigest: z.string(),
  databaseAdapterDigest: z.string().optional(),
  browser: z.object({
    name: z.string(),
    version: z.string(),
    headless: z.boolean(),
  }),
  capture: z.object({
    ui: z.literal(true),
    network: z.literal(true),
    database: z.boolean(),
    externalEvents: z.boolean(),
    screenshots: z.boolean(),
    rawTrace: z.boolean(),
  }),
  counts: z.object({
    steps: z.number().int().nonnegative(),
    snapshots: z.number().int().nonnegative(),
    networkExchanges: z.number().int().nonnegative(),
    consoleEntries: z.number().int().nonnegative(),
    databaseChanges: z.number().int().nonnegative(),
    manualEvents: z.number().int().nonnegative(),
  }),
  files: z.object({
    actions: z.literal("actions.jsonl"),
    snapshots: z.literal("snapshots.jsonl"),
    network: z.literal("network.jsonl"),
    console: z.literal("console.jsonl"),
    manualEvents: z.literal("manual-events.jsonl"),
    trace: z.literal("trace.zip").optional(),
  }),
});

export type RecordingManifest = z.infer<typeof recordingManifestSchema>;

export const workflowScriptSchema = z.object({
  workflow: z.string().min(1),
  steps: z.array(recordedActionSchema).min(1),
});

export type WorkflowScript = z.infer<typeof workflowScriptSchema>;
