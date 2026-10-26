import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { BrowserRecorder } from "./recorder/recorder.ts";
import {
  capturePolicySchema,
  databaseAdapterSchema,
  workflowScriptSchema,
  type CapturePolicy,
  type DatabaseAdapter,
  type WorkflowScript,
} from "./observation/schema.ts";
import { createCapturePolicy } from "./observation/policy.ts";
import { startFixtureServer } from "./fixture/server.ts";
import { compareRecordingDirectories } from "./diff/compare.ts";
import { runDifferentialComparison } from "./diff/runner.ts";
import { writeComparisonReport } from "./diff/report.ts";
import { normalizationProfileSchema, type NormalizationProfile } from "./diff/schema.ts";
import { adjudicateComparison } from "./review/adjudicate.ts";
import { writeReviewResult } from "./review/report.ts";
import { loadComparisonReport, startReviewServer } from "./review/server.ts";
import { loadRuleSet } from "./review/store.ts";

type Flags = Record<string, string | boolean>;

async function main(): Promise<void> {
  const [command = "help", ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  if (command === "fixture") return runFixture(flags);
  if (command === "record") return runRecord(flags);
  if (command === "diff") return runDiff(flags);
  if (command === "compare") return runCompare(flags);
  if (command === "review") return runReview(flags);
  if (command === "adjudicate") return runAdjudicate(flags);
  printHelp();
}

async function runFixture(flags: Flags): Promise<void> {
  const port = flags.port ? Number(flags.port) : 4317;
  const fixture = await startFixtureServer(port);
  console.log(`Invoice fixture is ready at ${fixture.url}`);
  console.log("Press Ctrl+C to stop it.");
  await new Promise<void>((resolveDone) => {
    process.once("SIGINT", () => resolveDone());
    process.once("SIGTERM", () => resolveDone());
  });
  await fixture.close();
}

async function runRecord(flags: Flags): Promise<void> {
  const sourceUrl = requireString(flags.url, "--url");
  const script = flags.script ? await loadScript(String(flags.script)) : undefined;
  const workflow = String(flags.workflow ?? script?.workflow ?? "recorded-workflow");
  const outputRoot = resolve(String(flags.out ?? "artifacts/runs"));
  const databaseSnapshotUrl = flags["db-snapshot-url"] ? String(flags["db-snapshot-url"]) : undefined;
  const policy = flags.policy
    ? await loadPolicy(String(flags.policy))
    : createCapturePolicy({
        sourceUrl,
        databaseSnapshotUrl,
        tenant: requireString(flags.tenant, "--tenant"),
        identity: requireString(flags.identity, "--identity"),
      });
  const databaseAdapter = flags["db-adapter"]
    ? await loadDatabaseAdapter(String(flags["db-adapter"]))
    : undefined;
  const recorder = new BrowserRecorder({
    sourceUrl,
    workflow,
    outputRoot,
    headless: Boolean(flags.headless || (script && !flags.headed)),
    chromeExecutable: flags.chrome ? String(flags.chrome) : undefined,
    policy,
    databaseSnapshotUrl,
    databaseAdapter,
  });

  const result = script
    ? await recorder.runScript(script)
    : await recorder.runManual(async () => {
        const prompt = createInterface({ input, output });
        await prompt.question("Recording is active. Perform the workflow, then press Enter here to finish.\n");
        prompt.close();
      });

  console.log(`Recorded ${result.manifest.counts.steps} steps to ${result.runDirectory}`);
  console.log(
    `Captured ${result.manifest.counts.networkExchanges} network exchanges and ${result.manifest.counts.databaseChanges} database changes.`,
  );
}

async function runDiff(flags: Flags): Promise<void> {
  const sourceRun = requireString(flags["source-run"], "--source-run");
  const replicaRun = requireString(flags["replica-run"], "--replica-run");
  const normalization = flags.normalization
    ? await loadNormalization(String(flags.normalization))
    : undefined;
  const report = await compareRecordingDirectories(sourceRun, replicaRun, normalization);
  const written = await writeComparisonReport(report, resolve(String(flags.out ?? "artifacts/comparisons")));
  await applyRulesIfConfigured(report, written.directory, flags);
  printComparisonResult(report.parityScore, report.counts.differences, written.directory);
}

async function runCompare(flags: Flags): Promise<void> {
  const sourceUrl = requireString(flags["source-url"], "--source-url");
  const replicaUrl = requireString(flags["replica-url"], "--replica-url");
  const workflow = await loadScript(requireString(flags.script, "--script"));
  const sourceDatabaseSnapshotUrl = optionalString(flags["source-db-snapshot-url"]);
  const replicaDatabaseSnapshotUrl = optionalString(flags["replica-db-snapshot-url"]);
  const sharedAdapter = flags["db-adapter"]
    ? await loadDatabaseAdapter(String(flags["db-adapter"]))
    : undefined;
  const sourceAdapter = flags["source-db-adapter"]
    ? await loadDatabaseAdapter(String(flags["source-db-adapter"]))
    : sharedAdapter;
  const replicaAdapter = flags["replica-db-adapter"]
    ? await loadDatabaseAdapter(String(flags["replica-db-adapter"]))
    : sharedAdapter;
  const sourcePolicy = flags["source-policy"]
    ? await loadPolicy(String(flags["source-policy"]))
    : createCapturePolicy({
        sourceUrl,
        databaseSnapshotUrl: sourceDatabaseSnapshotUrl,
        tenant: requireString(flags["source-tenant"], "--source-tenant"),
        identity: requireString(flags["source-identity"], "--source-identity"),
      });
  const replicaPolicy = flags["replica-policy"]
    ? await loadPolicy(String(flags["replica-policy"]))
    : createCapturePolicy({
        sourceUrl: replicaUrl,
        databaseSnapshotUrl: replicaDatabaseSnapshotUrl,
        tenant: requireString(flags["replica-tenant"], "--replica-tenant"),
        identity: requireString(flags["replica-identity"], "--replica-identity"),
      });
  const normalization = flags.normalization
    ? await loadNormalization(String(flags.normalization))
    : undefined;
  const result = await runDifferentialComparison({
    workflow,
    source: {
      url: sourceUrl,
      policy: sourcePolicy,
      databaseSnapshotUrl: sourceDatabaseSnapshotUrl,
      databaseAdapter: sourceAdapter,
    },
    replica: {
      url: replicaUrl,
      policy: replicaPolicy,
      databaseSnapshotUrl: replicaDatabaseSnapshotUrl,
      databaseAdapter: replicaAdapter,
    },
    normalization,
    outputRoot: resolve(String(flags.out ?? "artifacts/comparisons")),
    headless: !flags.headed,
    chromeExecutable: optionalString(flags.chrome),
  });
  await applyRulesIfConfigured(result.report, result.reportDirectory, flags);
  printComparisonResult(result.report.parityScore, result.report.counts.differences, result.reportDirectory);
}

async function runReview(flags: Flags): Promise<void> {
  const reportPath = resolve(requireString(flags.report, "--report"));
  const rulesPath = resolve(String(flags.rules ?? "artifacts/review-rules.json"));
  const port = flags.port ? Number(flags.port) : 0;
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error("--port must be a valid TCP port");
  const server = await startReviewServer({ reportPath, rulesPath, port });
  console.log(`Review surface is ready at ${server.url}`);
  console.log(`Decisions will be saved to ${rulesPath}`);
  console.log("Press Ctrl+C to stop it.");
  await new Promise<void>((resolveDone) => {
    process.once("SIGINT", resolveDone);
    process.once("SIGTERM", resolveDone);
  });
  await server.close();
}

async function runAdjudicate(flags: Flags): Promise<void> {
  const reportPath = resolve(requireString(flags.report, "--report"));
  const rulesPath = resolve(String(flags.rules ?? "artifacts/review-rules.json"));
  const outputDirectory = resolve(String(flags.out ?? dirname(reportPath)));
  const report = await loadComparisonReport(reportPath);
  const result = adjudicateComparison(report, await loadRuleSet(rulesPath));
  const written = await writeReviewResult(result, outputDirectory);
  console.log(
    `Accepted-difference parity ${(result.adjustedParityScore * 100).toFixed(1)}%; ${result.counts.actionable} must fix and ${result.counts.unresolved} unresolved.`,
  );
  console.log(`Review written to ${written.markdownPath}`);
}

async function applyRulesIfConfigured(
  report: Awaited<ReturnType<typeof compareRecordingDirectories>>,
  reportDirectory: string,
  flags: Flags,
): Promise<void> {
  if (!flags.rules) return;
  const result = adjudicateComparison(report, await loadRuleSet(String(flags.rules)));
  await writeReviewResult(result, reportDirectory);
}

async function loadScript(path: string): Promise<WorkflowScript> {
  return workflowScriptSchema.parse(JSON.parse(await readFile(resolve(path), "utf8")));
}

async function loadPolicy(path: string): Promise<CapturePolicy> {
  return capturePolicySchema.parse(JSON.parse(await readFile(resolve(path), "utf8")));
}

async function loadDatabaseAdapter(path: string): Promise<DatabaseAdapter> {
  return databaseAdapterSchema.parse(JSON.parse(await readFile(resolve(path), "utf8")));
}

async function loadNormalization(path: string): Promise<NormalizationProfile> {
  return normalizationProfileSchema.parse(JSON.parse(await readFile(resolve(path), "utf8")));
}

function requireString(value: string | boolean | undefined, name: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${name} is required`);
  return value;
}

function optionalString(value: string | boolean | undefined): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function printComparisonResult(parityScore: number, differences: number, directory: string): void {
  console.log(`Parity ${(parityScore * 100).toFixed(1)}% with ${differences} differences.`);
  console.log(`Report written to ${directory}`);
}

function parseFlags(values: string[]): Flags {
  const flags: Flags = {};
  for (let index = 0; index < values.length; index += 1) {
    const token = values[index];
    if (!token?.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    const next = values[index + 1];
    if (next && !next.startsWith("--")) {
      flags[key] = next;
      index += 1;
    } else {
      flags[key] = true;
    }
  }
  return flags;
}

function printHelp(): void {
  console.log(`Replicator\n\nCommands:\n  fixture [--port 4317]\n  record --url URL --tenant TENANT --identity IDENTITY [--workflow NAME] [--script FILE] [--db-snapshot-url URL --db-adapter FILE] [--policy FILE] [--out DIR]\n  diff --source-run DIR --replica-run DIR [--normalization FILE] [--rules FILE] [--out DIR]\n  compare --source-url URL --replica-url URL --script FILE --source-tenant TENANT --source-identity ID --replica-tenant TENANT --replica-identity ID [--db-adapter FILE] [--normalization FILE] [--rules FILE] [--out DIR]\n  review --report comparison.json [--rules FILE] [--port PORT]\n  adjudicate --report comparison.json [--rules FILE] [--out DIR]\n`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
