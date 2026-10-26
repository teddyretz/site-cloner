import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { comparisonReportSchema, type ComparisonReport } from "../src/diff/schema.ts";
import {
  adjudicateComparison,
  createEmptyRuleSet,
  matchingRule,
  upsertReviewRule,
} from "../src/review/adjudicate.ts";
import { startReviewServer } from "../src/review/server.ts";
import { loadRuleSet } from "../src/review/store.ts";

const report = comparisonReportSchema.parse({
  schemaVersion: "0.1.0",
  comparisonId: "comparison-review-test",
  createdAt: "2026-01-01T00:00:00.000Z",
  source: { runId: "source-run", workflow: "create-invoice", url: "https://source.example" },
  replica: { runId: "replica-run", workflow: "create-invoice", url: "https://replica.example" },
  normalization: { profileVersion: "1" },
  normalizationDigest: "normalization-digest",
  parityScore: 0,
  checks: { total: 2, matched: 0 },
  counts: {
    differences: 2,
    byLayer: { ui: 1, data: 1 },
    byClassification: { behavioral: 1, data: 1 },
  },
  steps: [{ index: 0, status: "different", differenceIds: ["difference-0001", "difference-0002"] }],
  differences: [
    {
      id: "difference-0001",
      stepIndex: 0,
      layer: "ui",
      classification: "behavioral",
      path: "steps[0].ui.accessibility",
      summary: "Accessibility trees differ",
      expected: "Status: draft",
      actual: "Status: pending",
    },
    {
      id: "difference-0002",
      stepIndex: 0,
      layer: "data",
      classification: "data",
      path: "steps[0].databaseChanges",
      summary: "Database effects differ",
      expected: { status: "draft" },
      actual: { status: "pending" },
    },
  ],
});

test("exact review rules do not hide future values", () => {
  const first = upsertReviewRule(createEmptyRuleSet(), report, report.differences[0]!, {
    decision: "expected",
    scope: "exact",
    note: "Known rollout label",
    reviewer: "tester",
  });
  const reviewed = adjudicateComparison(report, first.ruleSet);
  assert.equal(reviewed.counts.accepted, 1);
  assert.equal(reviewed.counts.unresolved, 1);
  assert.equal(reviewed.adjustedParityScore, 0.5);

  const futureReport: ComparisonReport = comparisonReportSchema.parse({
    ...report,
    comparisonId: "future-comparison",
    differences: report.differences.map((difference, index) =>
      index === 0 ? { ...difference, actual: "Status: failed" } : difference,
    ),
  });
  assert.equal(matchingRule(futureReport, futureReport.differences[0]!, first.ruleSet), undefined);
});

test("path rules match future values while exact rules take precedence", () => {
  const pathRule = upsertReviewRule(createEmptyRuleSet(), report, report.differences[0]!, {
    decision: "noise",
    scope: "path",
    note: "Ignore labels at this checkpoint",
    reviewer: "tester",
  });
  const exactRule = upsertReviewRule(pathRule.ruleSet, report, report.differences[0]!, {
    decision: "fix-replica",
    scope: "exact",
    note: "This exact state is actionable",
    reviewer: "tester",
  });
  assert.equal(matchingRule(report, report.differences[0]!, exactRule.ruleSet)?.decision, "fix-replica");

  const changed = comparisonReportSchema.parse({
    ...report,
    comparisonId: "changed-comparison",
    differences: report.differences.map((difference, index) =>
      index === 0 ? { ...difference, actual: "Status: failed" } : difference,
    ),
  });
  assert.equal(matchingRule(changed, changed.differences[0]!, exactRule.ruleSet)?.decision, "noise");
});

test("local review surface saves an approved reusable decision", async () => {
  const directory = await mkdtemp(join(tmpdir(), "replicator-review-test-"));
  const reportPath = join(directory, "comparison.json");
  const rulesPath = join(directory, "review-rules.json");
  await writeFile(reportPath, JSON.stringify(report), "utf8");
  const server = await startReviewServer({ reportPath, rulesPath });
  try {
    const reviewUrl = new URL(server.url);
    const token = reviewUrl.searchParams.get("token");
    assert.ok(token);
    const pageResponse = await fetch(server.url);
    assert.equal(pageResponse.status, 200);
    assert.match(await pageResponse.text(), /Replicator review/);

    const headers = { "content-type": "application/json", "x-replicator-review-token": token };
    const initial = await fetch(`${reviewUrl.origin}/api/review`, { headers });
    assert.equal(initial.status, 200);
    const save = await fetch(`${reviewUrl.origin}/api/decision`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        differenceId: "difference-0002",
        decision: "legacy-bug",
        scope: "exact",
        note: "The source stores the wrong status",
        reviewer: "integration-reviewer",
      }),
    });
    assert.equal(save.status, 200);
    const body = (await save.json()) as { review: { counts: { accepted: number; reviewed: number } } };
    assert.equal(body.review.counts.accepted, 1);
    assert.equal(body.review.counts.reviewed, 1);
    const stored = await loadRuleSet(rulesPath);
    assert.equal(stored.rules[0]?.decision, "legacy-bug");
    assert.equal(stored.rules[0]?.reviewer, "integration-reviewer");
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
