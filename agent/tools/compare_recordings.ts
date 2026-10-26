import { defineTool } from "eve/tools";
import { z } from "zod";
import { compareRecordingDirectories } from "../../src/diff/compare.ts";
import { resolveRunDirectory } from "../../src/observation/artifacts.ts";
import { adjudicateComparison } from "../../src/review/adjudicate.ts";
import { loadRuleSet } from "../../src/review/store.ts";

const runIdSchema = z.string().regex(/^[a-zA-Z0-9._-]+$/);

const outputSchema = z.object({
  comparisonId: z.string(),
  sourceRunId: z.string(),
  replicaRunId: z.string(),
  parityPercent: z.number(),
  checks: z.object({ total: z.number(), matched: z.number() }),
  counts: z.object({
    differences: z.number(),
    byLayer: z.record(z.string(), z.number()),
    byClassification: z.record(z.string(), z.number()),
  }),
  differences: z.array(
    z.object({
      id: z.string(),
      stepIndex: z.number(),
      layer: z.string(),
      classification: z.string(),
      path: z.string(),
      summary: z.string(),
      decision: z.string(),
    }),
  ),
  review: z.object({
    adjustedParityPercent: z.number(),
    reviewed: z.number(),
    accepted: z.number(),
    actionable: z.number(),
    unresolved: z.number(),
  }),
  truncated: z.boolean(),
});

export default defineTool({
  description:
    "Compare two authorized local workflow recordings and summarize normalized UI, API, and database parity.",
  inputSchema: z.object({
    sourceRunId: runIdSchema,
    replicaRunId: runIdSchema,
  }),
  outputSchema,
  label: {
    start: ({ sourceRunId, replicaRunId }) => `Compare ${sourceRunId} with ${replicaRunId}`,
  },
  async execute({ sourceRunId, replicaRunId }) {
    const root = process.env.REPLICATOR_RUNS_DIR ?? "artifacts/runs";
    const [sourceDirectory, replicaDirectory] = await Promise.all([
      resolveRunDirectory(root, sourceRunId),
      resolveRunDirectory(root, replicaRunId),
    ]);
    const report = await compareRecordingDirectories(sourceDirectory, replicaDirectory);
    const review = adjudicateComparison(
      report,
      await loadRuleSet(process.env.REPLICATOR_RULES_FILE ?? "artifacts/review-rules.json"),
    );
    const reviewById = new Map(review.differences.map((item) => [item.difference.id, item]));
    const visibleDifferences = report.differences.slice(0, 50).map(
      ({ id, stepIndex, layer, classification, path, summary }) => ({
        id,
        stepIndex,
        layer,
        classification,
        path,
        summary,
        decision: reviewById.get(id)?.decision ?? "unresolved",
      }),
    );
    return {
      comparisonId: report.comparisonId,
      sourceRunId: report.source.runId,
      replicaRunId: report.replica.runId,
      parityPercent: Number((report.parityScore * 100).toFixed(1)),
      checks: report.checks,
      counts: report.counts,
      differences: visibleDifferences,
      review: {
        adjustedParityPercent: Number((review.adjustedParityScore * 100).toFixed(1)),
        reviewed: review.counts.reviewed,
        accepted: review.counts.accepted,
        actionable: review.counts.actionable,
        unresolved: review.counts.unresolved,
      },
      truncated: report.differences.length > visibleDifferences.length,
    };
  },
});
