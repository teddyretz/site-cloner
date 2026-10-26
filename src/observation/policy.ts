import {
  capturePolicySchema,
  type ActionRisk,
  type CapturePolicy,
  type RecordedAction,
} from "./schema.ts";
import { stableHash } from "./normalize.ts";

const riskRank: Record<ActionRisk, number> = {
  read: 0,
  write: 1,
  external: 2,
  destructive: 3,
};

export function createCapturePolicy(input: {
  sourceUrl: string;
  tenant: string;
  identity: string;
  databaseSnapshotUrl?: string;
  overrides?: Partial<CapturePolicy>;
}): CapturePolicy {
  const sourceOrigin = new URL(input.sourceUrl).origin;
  const databaseOrigins = input.databaseSnapshotUrl ? [new URL(input.databaseSnapshotUrl).origin] : [];
  return capturePolicySchema.parse({
    policyVersion: "1",
    dataMode: "test-data-only",
    tenant: input.tenant,
    identity: input.identity,
    allowedOrigins: [sourceOrigin],
    databaseOrigins,
    limits: {},
    settlement: {},
    ...input.overrides,
  });
}

export function policyDigest(policy: CapturePolicy): string {
  return stableHash(capturePolicySchema.parse(policy));
}

export function assertUrlAllowed(rawUrl: string, allowedOrigins: string[], purpose = "request"): void {
  const url = new URL(rawUrl);
  if (["about:", "blob:", "data:"].includes(url.protocol)) return;
  const allowed = new Set(allowedOrigins.map((origin) => new URL(origin).origin));
  if (!allowed.has(url.origin)) throw new Error(`${purpose} origin is outside capture policy: ${url.origin}`);
}

export function inferredActionRisk(action: RecordedAction): ActionRisk {
  if (action.risk) return action.risk;
  if (["click", "submit", "upload"].includes(action.kind)) return "write";
  return "read";
}

export function assertActionAllowed(action: RecordedAction, policy: CapturePolicy): void {
  const risk = inferredActionRisk(action);
  if (riskRank[risk] > riskRank[policy.maxActionRisk]) {
    throw new Error(`Action risk ${risk} exceeds policy maximum ${policy.maxActionRisk}`);
  }
  if (action.url) assertUrlAllowed(action.url, policy.allowedOrigins, "navigation");
}
