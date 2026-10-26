import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import { compareRecordingDirectories } from "../../src/diff/compare.ts";
import { resolveRunDirectory } from "../../src/observation/artifacts.ts";
import { adjudicateComparison, upsertReviewRule } from "../../src/review/adjudicate.ts";
import { reviewDecisionSchema, reviewRuleScopeSchema } from "../../src/review/schema.ts";
import { loadRuleSet, updateRuleSet } from "../../src/review/store.ts";

const runIdSchema = z.string().regex(/^[a-zA-Z0-9._-]+$/);

const outputSchema = z.object({
  ruleId: z.string(),
  differenceId: z.string(),
  decision: reviewDecisionSchema,
  scope: reviewRuleScopeSchema,
  adjustedParityPercent: z.number(),
  counts: z.object({
    reviewed: z.number(),
    accepted: z.number(),
    actionable: z.number(),
    unresolved: z.number(),
  }),
});

export default defineTool({
  description:
    "Save a human-approved judgment for one source-versus-replica difference as a reusable review rule.",
  inputSchema: z.object({
    sourceRunId: runIdSchema,
    replicaRunId: runIdSchema,
    differenceId: z.string().regex(/^difference-\d+$/),
    decision: reviewDecisionSchema,
    scope: reviewRuleScopeSchema.default("exact"),
    note: z.string().max(4_000).default(""),
  }),
  outputSchema,
  approval: {
    request: always(),
    prompt: ({ input }) =>
      `Save “${input.decision}” as a ${input.scope} rule for ${input.differenceId}?`,
  },
  label: {
    start: ({ differenceId, decision }) => `Review ${differenceId} as ${decision}`,
  },
  async execute(input, context) {
    const runsRoot = process.env.REPLICATOR_RUNS_DIR ?? "artifacts/runs";
    const rulesPath = process.env.REPLICATOR_RULES_FILE ?? "artifacts/review-rules.json";
    const [sourceDirectory, replicaDirectory] = await Promise.all([
      resolveRunDirectory(runsRoot, input.sourceRunId),
      resolveRunDirectory(runsRoot, input.replicaRunId),
    ]);
    const report = await compareRecordingDirectories(sourceDirectory, replicaDirectory);
    const difference = report.differences.find(({ id }) => id === input.differenceId);
    if (!difference) throw new Error(`Difference ${input.differenceId} was not found in this comparison`);
    const reviewer = context.session.auth.current?.principalId ?? "eve-reviewer";
    const rule = await updateRuleSet(rulesPath, (ruleSet) => {
      const updated = upsertReviewRule(ruleSet, report, difference, {
        decision: input.decision,
        scope: input.scope,
        note: input.note,
        reviewer,
      });
      return { ruleSet: updated.ruleSet, result: updated.rule };
    });
    const review = adjudicateComparison(report, await loadRuleSet(rulesPath));
    return {
      ruleId: rule.id,
      differenceId: difference.id,
      decision: rule.decision,
      scope: rule.scope,
      adjustedParityPercent: Number((review.adjustedParityScore * 100).toFixed(1)),
      counts: {
        reviewed: review.counts.reviewed,
        accepted: review.counts.accepted,
        actionable: review.counts.actionable,
        unresolved: review.counts.unresolved,
      },
    };
  },
});
