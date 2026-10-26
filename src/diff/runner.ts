import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { BrowserRecorder } from "../recorder/recorder.ts";
import type {
  CapturePolicy,
  DatabaseAdapter,
  WorkflowScript,
} from "../observation/schema.ts";
import { compareRecordingDirectories } from "./compare.ts";
import { writeComparisonReport } from "./report.ts";
import type { ComparisonReport, NormalizationProfile } from "./schema.ts";

export type DifferentialTarget = {
  url: string;
  policy: CapturePolicy;
  databaseSnapshotUrl?: string;
  databaseAdapter?: DatabaseAdapter;
};

export type DifferentialRunOptions = {
  workflow: WorkflowScript;
  source: DifferentialTarget;
  replica: DifferentialTarget;
  outputRoot: string;
  normalization?: Partial<NormalizationProfile>;
  headless?: boolean;
  chromeExecutable?: string;
};

export type DifferentialRunResult = {
  report: ComparisonReport;
  reportDirectory: string;
  sourceRunDirectory: string;
  replicaRunDirectory: string;
};

export async function runDifferentialComparison(options: DifferentialRunOptions): Promise<DifferentialRunResult> {
  const executionId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const runsRoot = join(options.outputRoot, executionId, "runs");
  const sourceRecorder = new BrowserRecorder({
    sourceUrl: options.source.url,
    workflow: options.workflow.workflow,
    outputRoot: join(runsRoot, "source"),
    headless: options.headless ?? true,
    chromeExecutable: options.chromeExecutable,
    policy: options.source.policy,
    databaseSnapshotUrl: options.source.databaseSnapshotUrl,
    databaseAdapter: options.source.databaseAdapter,
  });
  const replicaRecorder = new BrowserRecorder({
    sourceUrl: options.replica.url,
    workflow: options.workflow.workflow,
    outputRoot: join(runsRoot, "replica"),
    headless: options.headless ?? true,
    chromeExecutable: options.chromeExecutable,
    policy: options.replica.policy,
    databaseSnapshotUrl: options.replica.databaseSnapshotUrl,
    databaseAdapter: options.replica.databaseAdapter,
  });
  const [sourceRun, replicaRun] = await Promise.all([
    sourceRecorder.runScript(options.workflow),
    replicaRecorder.runScript(options.workflow),
  ]);
  const report = await compareRecordingDirectories(
    sourceRun.runDirectory,
    replicaRun.runDirectory,
    options.normalization,
  );
  const written = await writeComparisonReport(report, join(options.outputRoot, executionId));
  return {
    report,
    reportDirectory: written.directory,
    sourceRunDirectory: sourceRun.runDirectory,
    replicaRunDirectory: replicaRun.runDirectory,
  };
}
