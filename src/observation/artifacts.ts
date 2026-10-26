import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import {
  consoleEntrySchema,
  manualEventSchema,
  networkExchangeSchema,
  pageSnapshotSchema,
  recordedStepSchema,
  recordingManifestSchema,
  type ConsoleEntry,
  type ManualEvent,
  type NetworkExchange,
  type PageSnapshot,
  type RecordedStep,
  type RecordingManifest,
} from "./schema.ts";
import { policyDigest } from "./policy.ts";

const MAX_MANIFEST_BYTES = 1024 * 1024;

export type RecordingBundle = {
  manifest: RecordingManifest;
  steps: RecordedStep[];
  snapshots: PageSnapshot[];
  network: NetworkExchange[];
  consoleEntries: ConsoleEntry[];
  manualEvents: ManualEvent[];
};

export async function resolveRunDirectory(runsRoot: string, runId: string): Promise<string> {
  if (!/^[a-zA-Z0-9._-]+$/.test(runId)) throw new Error("Run ID contains unsupported characters");
  const root = await realpath(resolve(runsRoot));
  const directory = resolve(root, runId);
  if (!directory.startsWith(`${root}${sep}`)) throw new Error("Recording path escapes the configured run directory");
  const metadata = await lstat(directory);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error("Recording must be a real directory");
  const resolved = await realpath(directory);
  if (!resolved.startsWith(`${root}${sep}`)) throw new Error("Recording resolves outside the configured run directory");
  return resolved;
}

export async function loadRecording(runDirectory: string): Promise<RecordingBundle> {
  const manifest = recordingManifestSchema.parse(
    JSON.parse(await readArtifactText(runDirectory, "manifest.json", MAX_MANIFEST_BYTES)),
  );
  if (manifest.policyDigest !== policyDigest(manifest.policy)) throw new Error("Capture policy digest does not match manifest");
  const maxBytes = Math.min(manifest.policy.limits.artifactBytes, 50 * 1024 * 1024);
  const [steps, snapshots, network, consoleEntries, manualEvents] = await Promise.all([
    readJsonLines(runDirectory, manifest.files.actions, maxBytes, recordedStepSchema.parse),
    readJsonLines(runDirectory, manifest.files.snapshots, maxBytes, pageSnapshotSchema.parse),
    readJsonLines(runDirectory, manifest.files.network, maxBytes, networkExchangeSchema.parse),
    readJsonLines(runDirectory, manifest.files.console, maxBytes, consoleEntrySchema.parse),
    readJsonLines(runDirectory, manifest.files.manualEvents, maxBytes, manualEventSchema.parse),
  ]);
  await validateBundleReferences(runDirectory, manifest, steps, snapshots, network, consoleEntries, manualEvents);
  return { manifest, steps, snapshots, network, consoleEntries, manualEvents };
}

export async function readArtifactText(runDirectory: string, relativePath: string, maxBytes: number): Promise<string> {
  return readFile(await resolveArtifactFile(runDirectory, relativePath, maxBytes), "utf8");
}

export async function resolveArtifactFile(
  runDirectory: string,
  relativePath: string,
  maxBytes: number,
): Promise<string> {
  if (isAbsolute(relativePath) || relativePath.includes("\0")) throw new Error("Artifact path must be relative");
  const runRoot = await realpath(runDirectory);
  const candidate = resolve(runRoot, relativePath);
  if (!candidate.startsWith(`${runRoot}${sep}`)) throw new Error("Artifact path escapes its run directory");
  const metadata = await lstat(candidate);
  if (metadata.isSymbolicLink()) throw new Error("Artifact files may not be symbolic links");
  if (!metadata.isFile()) throw new Error("Artifact path is not a file");
  if (metadata.size > maxBytes) throw new Error(`Artifact exceeds ${maxBytes} bytes`);
  const resolvedFile = await realpath(candidate);
  if (!resolvedFile.startsWith(`${runRoot}${sep}`)) throw new Error("Artifact resolves outside its run directory");
  return resolvedFile;
}

async function readJsonLines<T>(
  runDirectory: string,
  relativePath: string,
  maxBytes: number,
  parse: (value: unknown) => T,
): Promise<T[]> {
  const text = await readArtifactText(runDirectory, relativePath, maxBytes);
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => parse(JSON.parse(line)));
}

async function validateBundleReferences(
  runDirectory: string,
  manifest: RecordingManifest,
  steps: RecordedStep[],
  snapshots: PageSnapshot[],
  network: NetworkExchange[],
  consoleEntries: ConsoleEntry[],
  manualEvents: ManualEvent[],
): Promise<void> {
  const snapshotIds = new Set(snapshots.map(({ id }) => id));
  if (snapshotIds.size !== snapshots.length) throw new Error("Recording contains duplicate snapshot IDs");
  for (const step of steps) {
    if (!snapshotIds.has(step.beforeSnapshotId) || !snapshotIds.has(step.afterSnapshotId)) {
      throw new Error(`Step ${step.index} references a missing snapshot`);
    }
  }
  const maxBytes = Math.min(manifest.policy.limits.artifactBytes, 50 * 1024 * 1024);
  await Promise.all(
    snapshots.flatMap((snapshot) => [
      resolveArtifactFile(runDirectory, snapshot.domPath, maxBytes),
      ...(snapshot.screenshotPath ? [resolveArtifactFile(runDirectory, snapshot.screenshotPath, maxBytes)] : []),
    ]),
  );
  const expected = manifest.counts;
  const actualDatabaseChanges = steps.reduce((total, step) => total + step.databaseChanges.length, 0);
  if (
    expected.steps !== steps.length ||
    expected.snapshots !== snapshots.length ||
    expected.networkExchanges !== network.length ||
    expected.consoleEntries !== consoleEntries.length ||
    expected.databaseChanges !== actualDatabaseChanges ||
    expected.manualEvents !== manualEvents.length
  ) {
    throw new Error(`Recording counts do not match persisted artifacts in ${runDirectory}`);
  }
}
