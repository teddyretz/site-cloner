import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { compareRecordingDirectories } from "../src/diff/compare.ts";
import { runDifferentialComparison } from "../src/diff/runner.ts";
import { startFixtureServer } from "../src/fixture/server.ts";
import { createCapturePolicy } from "../src/observation/policy.ts";
import type { DatabaseAdapter, WorkflowScript } from "../src/observation/schema.ts";

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

test("replays both targets and reports semantic UI, API, and data differences", { timeout: 50_000 }, async () => {
  const outputRoot = await mkdtemp(join(tmpdir(), "replicator-differential-test-"));
  const [sourceFixture, replicaFixture] = await Promise.all([
    startFixtureServer(0, 0, "reference"),
    startFixtureServer(0, 0, "divergent"),
  ]);
  try {
    const policyFor = (url: string) =>
      createCapturePolicy({
        sourceUrl: url,
        databaseSnapshotUrl: `${url}/__fixture/db-snapshot`,
        tenant: "fixture-tenant",
        identity: "fixture-operator",
        overrides: {
          screenshots: false,
          settlement: {
            timeoutMs: 4_000,
            minimumObservationMs: 300,
            quietWindowMs: 100,
            databasePollIntervalMs: 100,
            databaseStablePolls: 2,
          },
        },
      });
    const result = await runDifferentialComparison({
      workflow,
      source: {
        url: sourceFixture.url,
        policy: policyFor(sourceFixture.url),
        databaseSnapshotUrl: `${sourceFixture.url}/__fixture/db-snapshot`,
        databaseAdapter,
      },
      replica: {
        url: replicaFixture.url,
        policy: policyFor(replicaFixture.url),
        databaseSnapshotUrl: `${replicaFixture.url}/__fixture/db-snapshot`,
        databaseAdapter,
      },
      outputRoot,
      headless: true,
    });

    assert.ok(result.report.parityScore < 1);
    assert.ok(result.report.parityScore > 0);
    assert.ok(result.report.counts.byLayer.ui);
    assert.ok(result.report.counts.byLayer.api);
    assert.ok(result.report.counts.byLayer.data);
    assert.ok(result.report.differences.some(({ path }) => path.endsWith(".api")));
    assert.ok(result.report.differences.some(({ path }) => path.endsWith(".databaseChanges")));
    await Promise.all([
      access(join(result.reportDirectory, "comparison.json")),
      access(join(result.reportDirectory, "report.md")),
    ]);

    const selfComparison = await compareRecordingDirectories(
      result.sourceRunDirectory,
      result.sourceRunDirectory,
    );
    assert.equal(selfComparison.parityScore, 1);
    assert.equal(selfComparison.counts.differences, 0);
  } finally {
    await Promise.all([sourceFixture.close(), replicaFixture.close()]);
    await rm(outputRoot, { recursive: true, force: true });
  }
});
