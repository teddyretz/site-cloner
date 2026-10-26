import { z } from "zod";
import { differenceSchema } from "../diff/schema.ts";

export const REVIEW_SCHEMA_VERSION = "0.1.0";

export const reviewDecisionSchema = z.enum([
  "expected",
  "noise",
  "legacy-bug",
  "fix-replica",
  "unresolved",
]);
export type ReviewDecision = z.infer<typeof reviewDecisionSchema>;

export const reviewRuleScopeSchema = z.enum(["exact", "path"]);
export type ReviewRuleScope = z.infer<typeof reviewRuleScopeSchema>;

export const reviewRuleSchema = z
  .object({
    id: z.string(),
    workflow: z.string().min(1).max(500),
    layer: differenceSchema.shape.layer,
    path: z.string().min(1).max(2_000),
    scope: reviewRuleScopeSchema,
    fingerprint: z.string().length(64).optional(),
    decision: reviewDecisionSchema,
    note: z.string().max(4_000).default(""),
    reviewer: z.string().min(1).max(500),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .superRefine((rule, context) => {
    if (rule.scope === "exact" && !rule.fingerprint) {
      context.addIssue({ code: "custom", path: ["fingerprint"], message: "Exact rules require a fingerprint" });
    }
    if (rule.scope === "path" && rule.fingerprint) {
      context.addIssue({ code: "custom", path: ["fingerprint"], message: "Path rules may not contain a fingerprint" });
    }
  });

export type ReviewRule = z.infer<typeof reviewRuleSchema>;

export const reviewRuleSetSchema = z.object({
  schemaVersion: z.literal(REVIEW_SCHEMA_VERSION),
  updatedAt: z.string(),
  rules: z.array(reviewRuleSchema).max(100_000),
});

export type ReviewRuleSet = z.infer<typeof reviewRuleSetSchema>;

export const reviewDecisionInputSchema = z.object({
  differenceId: z.string(),
  decision: reviewDecisionSchema,
  scope: reviewRuleScopeSchema.default("exact"),
  note: z.string().max(4_000).default(""),
  reviewer: z.string().min(1).max(500).default("local-reviewer"),
});

export type ReviewDecisionInput = z.infer<typeof reviewDecisionInputSchema>;

export const reviewedDifferenceSchema = z.object({
  difference: differenceSchema,
  fingerprint: z.string().length(64),
  decision: reviewDecisionSchema,
  accepted: z.boolean(),
  rule: reviewRuleSchema.optional(),
});

export const reviewResultSchema = z.object({
  schemaVersion: z.literal(REVIEW_SCHEMA_VERSION),
  comparisonId: z.string(),
  workflow: z.string(),
  rulesDigest: z.string().length(64),
  originalParityScore: z.number().min(0).max(1),
  adjustedParityScore: z.number().min(0).max(1),
  counts: z.object({
    totalDifferences: z.number().int().nonnegative(),
    reviewed: z.number().int().nonnegative(),
    accepted: z.number().int().nonnegative(),
    actionable: z.number().int().nonnegative(),
    unresolved: z.number().int().nonnegative(),
    byDecision: z.record(z.string(), z.number().int().nonnegative()),
  }),
  differences: z.array(reviewedDifferenceSchema),
});

export type ReviewResult = z.infer<typeof reviewResultSchema>;
