import { randomUUID } from "node:crypto";
import type { JsonValue, PageSnapshot, RecordedStep } from "../observation/schema.ts";
import { loadRecording, type RecordingBundle } from "../observation/artifacts.ts";
import { stableHash, stableStringify } from "../observation/normalize.ts";
import {
  canonicalDatabaseChanges,
  canonicalNetworkExchange,
  includeNetworkExchange,
  normalizeText,
  normalizeUrlForComparison,
} from "./normalize.ts";
import {
  COMPARISON_SCHEMA_VERSION,
  comparisonReportSchema,
  normalizationProfileSchema,
  type ComparisonReport,
  type Difference,
  type NormalizationProfile,
} from "./schema.ts";

type MutableComparison = {
  differences: Difference[];
  totalChecks: number;
  matchedChecks: number;
};

export async function compareRecordingDirectories(
  sourceDirectory: string,
  replicaDirectory: string,
  rawProfile?: Partial<NormalizationProfile>,
): Promise<ComparisonReport> {
  const [source, replica] = await Promise.all([loadRecording(sourceDirectory), loadRecording(replicaDirectory)]);
  return compareRecordings(source, replica, rawProfile);
}

export function compareRecordings(
  source: RecordingBundle,
  replica: RecordingBundle,
  rawProfile?: Partial<NormalizationProfile>,
): ComparisonReport {
  const normalization = normalizationProfileSchema.parse({ profileVersion: "1", ...rawProfile });
  const state: MutableComparison = { differences: [], totalChecks: 0, matchedChecks: 0 };
  compareValue(state, -1, "workflow", "behavioral", "workflow.name", "Workflow names differ", source.manifest.workflow, replica.manifest.workflow);
  const maxSteps = Math.max(source.steps.length, replica.steps.length);
  const stepResults: ComparisonReport["steps"] = [];
  const sourceSnapshots = new Map(source.snapshots.map((snapshot) => [snapshot.id, snapshot]));
  const replicaSnapshots = new Map(replica.snapshots.map((snapshot) => [snapshot.id, snapshot]));
  const sourceNetwork = new Map(source.network.map((exchange) => [exchange.id, exchange]));
  const replicaNetwork = new Map(replica.network.map((exchange) => [exchange.id, exchange]));

  for (let index = 0; index < maxSteps; index += 1) {
    const beforeDifferenceCount = state.differences.length;
    const sourceStep = source.steps[index];
    const replicaStep = replica.steps[index];
    if (!sourceStep || !replicaStep) {
      state.totalChecks += 1;
      addDifference(state, {
        stepIndex: index,
        layer: "workflow",
        classification: "behavioral",
        path: `steps[${index}]`,
        summary: sourceStep ? "Replica is missing a workflow step" : "Replica has an extra workflow step",
        expected: sourceStep ? (sourceStep.actions.map(({ kind }) => kind) as JsonValue) : null,
        actual: replicaStep ? (replicaStep.actions.map(({ kind }) => kind) as JsonValue) : null,
      });
      stepResults.push({ index, status: "missing", differenceIds: differenceIdsSince(state, beforeDifferenceCount) });
      continue;
    }
    compareStepActions(state, index, sourceStep, replicaStep);
    compareSettlement(state, index, sourceStep, replicaStep);
    compareUi(
      state,
      index,
      requireSnapshot(sourceSnapshots, sourceStep.afterSnapshotId),
      requireSnapshot(replicaSnapshots, replicaStep.afterSnapshotId),
      normalization,
    );
    compareApi(state, index, sourceStep, replicaStep, sourceNetwork, replicaNetwork, normalization);
    compareValue(
      state,
      index,
      "data",
      "data",
      `steps[${index}].databaseChanges`,
      "Database effects differ",
      canonicalDatabaseChanges(sourceStep.databaseChanges, normalization),
      canonicalDatabaseChanges(replicaStep.databaseChanges, normalization),
    );
    const differenceIds = differenceIdsSince(state, beforeDifferenceCount);
    stepResults.push({ index, status: differenceIds.length ? "different" : "matched", differenceIds });
  }

  const byLayer = countBy(state.differences, ({ layer }) => layer);
  const byClassification = countBy(state.differences, ({ classification }) => classification);
  return comparisonReportSchema.parse({
    schemaVersion: COMPARISON_SCHEMA_VERSION,
    comparisonId: `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`,
    createdAt: new Date().toISOString(),
    source: {
      runId: source.manifest.runId,
      workflow: source.manifest.workflow,
      url: source.manifest.sourceUrl,
    },
    replica: {
      runId: replica.manifest.runId,
      workflow: replica.manifest.workflow,
      url: replica.manifest.sourceUrl,
    },
    normalization,
    normalizationDigest: stableHash(normalization),
    parityScore: state.totalChecks ? state.matchedChecks / state.totalChecks : 1,
    checks: { total: state.totalChecks, matched: state.matchedChecks },
    counts: { differences: state.differences.length, byLayer, byClassification },
    steps: stepResults,
    differences: state.differences,
  });
}

function compareStepActions(
  state: MutableComparison,
  index: number,
  source: RecordedStep,
  replica: RecordedStep,
): void {
  compareValue(
    state,
    index,
    "workflow",
    "behavioral",
    `steps[${index}].actions`,
    "Recorded actions differ",
    source.actions.map(({ kind, target, value, key }) => ({ kind, target: target ?? null, value: value ?? null, key: key ?? null })) as JsonValue,
    replica.actions.map(({ kind, target, value, key }) => ({ kind, target: target ?? null, value: value ?? null, key: key ?? null })) as JsonValue,
  );
}

function compareSettlement(
  state: MutableComparison,
  index: number,
  source: RecordedStep,
  replica: RecordedStep,
): void {
  state.totalChecks += 1;
  if (source.settlement.status === "settled" && replica.settlement.status === "settled") {
    state.matchedChecks += 1;
    return;
  }
  addDifference(state, {
    stepIndex: index,
    layer: "workflow",
    classification: "unresolved",
    path: `steps[${index}].settlement`,
    summary: "At least one side did not reach a settled state",
    expected: source.settlement.status,
    actual: replica.settlement.status,
  });
}

function compareUi(
  state: MutableComparison,
  index: number,
  source: PageSnapshot,
  replica: PageSnapshot,
  profile: NormalizationProfile,
): void {
  compareValue(
    state,
    index,
    "ui",
    "behavioral",
    `steps[${index}].ui.route`,
    "Routes differ",
    normalizeUrlForComparison(source.url, profile),
    normalizeUrlForComparison(replica.url, profile),
  );
  compareValue(
    state,
    index,
    "ui",
    "behavioral",
    `steps[${index}].ui.accessibility`,
    "Accessibility trees differ",
    normalizeText(source.aria, profile),
    normalizeText(replica.aria, profile),
  );
  compareValue(
    state,
    index,
    "ui",
    "cosmetic",
    `steps[${index}].ui.visibleText`,
    "Visible text differs",
    normalizeText(source.visibleText, profile),
    normalizeText(replica.visibleText, profile),
  );
}

function compareApi(
  state: MutableComparison,
  index: number,
  sourceStep: RecordedStep,
  replicaStep: RecordedStep,
  sourceNetwork: Map<string, RecordingBundle["network"][number]>,
  replicaNetwork: Map<string, RecordingBundle["network"][number]>,
  profile: NormalizationProfile,
): void {
  const source = sourceStep.networkExchangeIds
    .map((id) => sourceNetwork.get(id))
    .filter((value): value is RecordingBundle["network"][number] => Boolean(value))
    .filter((exchange) => includeNetworkExchange(exchange, profile))
    .map((exchange) => canonicalNetworkExchange(exchange, profile));
  const replica = replicaStep.networkExchangeIds
    .map((id) => replicaNetwork.get(id))
    .filter((value): value is RecordingBundle["network"][number] => Boolean(value))
    .filter((exchange) => includeNetworkExchange(exchange, profile))
    .map((exchange) => canonicalNetworkExchange(exchange, profile));
  compareValue(
    state,
    index,
    "api",
    "behavioral",
    `steps[${index}].api`,
    "Observable API exchanges differ",
    source,
    replica,
  );
}

function compareValue(
  state: MutableComparison,
  stepIndex: number,
  layer: Difference["layer"],
  classification: Difference["classification"],
  path: string,
  summary: string,
  expected: JsonValue,
  actual: JsonValue,
): void {
  state.totalChecks += 1;
  if (stableStringify(expected) === stableStringify(actual)) {
    state.matchedChecks += 1;
    return;
  }
  addDifference(state, { stepIndex, layer, classification, path, summary, expected, actual });
}

function addDifference(state: MutableComparison, difference: Omit<Difference, "id">): void {
  state.differences.push({ id: `difference-${String(state.differences.length + 1).padStart(4, "0")}`, ...difference });
}

function requireSnapshot(snapshots: Map<string, PageSnapshot>, id: string): PageSnapshot {
  const snapshot = snapshots.get(id);
  if (!snapshot) throw new Error(`Recording references missing snapshot ${id}`);
  return snapshot;
}

function differenceIdsSince(state: MutableComparison, index: number): string[] {
  return state.differences.slice(index).map(({ id }) => id);
}

function countBy<T>(values: T[], key: (value: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[key(value)] = (counts[key(value)] ?? 0) + 1;
  return counts;
}
