import assert from "node:assert/strict";
import { mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BrowserRecorder } from "../src/recorder/recorder.ts";
import { loadRecording } from "../src/observation/artifacts.ts";
import { createCapturePolicy } from "../src/observation/policy.ts";
import type { DatabaseAdapter, WorkflowScript } from "../src/observation/schema.ts";
import { startFixtureServer } from "../src/fixture/server.ts";

const workflow: WorkflowScript = {
  workflow: "create-invoice",
  steps: [
    { kind: "fill", target: { label: "Customer" }, value: "Acme Corp", risk: "read" },
    { kind: "fill", target: { label: "Description" }, value: "Implementation services", risk: "read" },
    { kind: "fill", target: { label: "Quantity" }, value: "2", risk: "read" },
    { kind: "fill", target: { label: "Unit price in cents" }, value: "12500", risk: "read" },
    { kind: "click", target: { role: "button", name: "Create invoice" }, risk: "write" },
  ],
};

const databaseAdapter: DatabaseAdapter = {
  adapterVersion: "1",
  tables: {
    invoices: { primaryKey: ["id"], logicalKey: ["number"], scope: {} },
    line_items: { primaryKey: ["id"], logicalKey: ["description"], scope: {} },
  },
};

test("persists reloadable UI, API, and delayed database evidence", { timeout: 40_000 }, async () => {
  const outputRoot = await mkdtemp(join(tmpdir(), "replicator-test-"));
  const fixture = await startFixtureServer(0, 350);
  try {
    const policy = createCapturePolicy({
      sourceUrl: fixture.url,
      databaseSnapshotUrl: `${fixture.url}/__fixture/db-snapshot`,
      tenant: "fixture-tenant",
      identity: "fixture-operator",
      overrides: {
        injectCorrelationHeaders: true,
        rawTrace: false,
        settlement: {
          timeoutMs: 5_000,
          minimumObservationMs: 650,
          quietWindowMs: 100,
          databasePollIntervalMs: 100,
          databaseStablePolls: 2,
        },
      },
    });
    const recorder = new BrowserRecorder({
      sourceUrl: fixture.url,
      workflow: workflow.workflow,
      outputRoot,
      headless: true,
      policy,
      databaseSnapshotUrl: `${fixture.url}/__fixture/db-snapshot`,
      databaseAdapter,
    });
    const result = await recorder.runScript(workflow);
    const bundle = await loadRecording(result.runDirectory);

    assert.equal(bundle.manifest.schemaVersion, "0.2.0");
    assert.equal(bundle.manifest.counts.steps, 5);
    assert.equal(bundle.snapshots.length, 6);
    assert.equal(bundle.manifest.counts.databaseChanges, 2);
    assert.equal(bundle.manifest.capture.rawTrace, false);
    assert.equal(bundle.manifest.files.trace, undefined);
    assert.ok(bundle.snapshots.every(({ aria, visibleText, domPath }) => aria && visibleText && domPath));
    assert.ok(bundle.steps.every(({ settlement }) => settlement.status === "settled"));
    assert.deepEqual(
      bundle.steps.at(-1)?.databaseChanges.map(({ table, operation }) => ({ table, operation })),
      [
        { table: "invoices", operation: "insert" },
        { table: "line_items", operation: "insert" },
      ],
    );
    assert.ok(bundle.network.some(({ method, correlationId }) => method === "POST" && correlationId));
    assert.match(bundle.steps.at(-1)?.afterSnapshotId ?? "", /snapshot-0006/);

    const outside = join(outputRoot, "outside.jsonl");
    const actions = join(result.runDirectory, "actions.jsonl");
    await writeFile(outside, "{}\n", "utf8");
    await rename(actions, `${actions}.original`);
    await symlink(outside, actions);
    await assert.rejects(loadRecording(result.runDirectory), /symbolic links/);
  } finally {
    await fixture.close();
    await rm(outputRoot, { recursive: true, force: true });
  }
});

test("manual mode journals and groups rapid human-style events honestly", { timeout: 30_000 }, async () => {
  const outputRoot = await mkdtemp(join(tmpdir(), "replicator-manual-test-"));
  const fixture = await startFixtureServer();
  try {
    const sourceUrl = `${fixture.url}/?autorun=1`;
    const policy = createCapturePolicy({
      sourceUrl,
      tenant: "fixture-tenant",
      identity: "fixture-operator",
      overrides: {
        screenshots: false,
        settlement: {
          timeoutMs: 4_000,
          minimumObservationMs: 300,
          quietWindowMs: 150,
          databasePollIntervalMs: 100,
          databaseStablePolls: 1,
        },
      },
    });
    const recorder = new BrowserRecorder({
      sourceUrl,
      workflow: "manual-create-invoice",
      outputRoot,
      headless: true,
      policy,
    });
    const result = await recorder.runManual(() => new Promise((resolve) => setTimeout(resolve, 1_800)));
    const bundle = await loadRecording(result.runDirectory);

    assert.ok(bundle.manualEvents.length >= 6);
    assert.ok(bundle.steps.length >= 1);
    assert.ok(bundle.steps.every(({ manualEventRange }) => manualEventRange));
    assert.ok(bundle.steps.flatMap(({ actions }) => actions).some(({ kind }) => kind === "submit" || kind === "click"));
    assert.ok(bundle.snapshots.every(({ screenshotPath }) => screenshotPath === undefined));
  } finally {
    await fixture.close();
    await rm(outputRoot, { recursive: true, force: true });
  }
});
