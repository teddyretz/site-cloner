import { randomUUID } from "node:crypto";
import type { ComparisonReport, Difference } from "../diff/schema.ts";
import { stableHash } from "../observation/normalize.ts";
import {
  REVIEW_SCHEMA_VERSION,
  reviewResultSchema,
  reviewRuleSetSchema,
  type ReviewDecision,
  type ReviewResult,
  type ReviewRule,
  type ReviewRuleScope,
  type ReviewRuleSet,
} from "./schema.ts";

const acceptedDecisions = new Set<ReviewDecision>(["expected", "noise", "legacy-bug"]);

export function createEmptyRuleSet(now = new Date().toISOString()): ReviewRuleSet {
  return { schemaVersion: REVIEW_SCHEMA_VERSION, updatedAt: now, rules: [] };
}

export function differenceFingerprint(difference: Difference): string {
  return stableHash({
    layer: difference.layer,
    path: difference.path,
    expected: difference.expected,
    actual: difference.actual,
  });
}

export function matchingRule(
  report: ComparisonReport,
  difference: Difference,
  rawRuleSet: ReviewRuleSet,
): ReviewRule | undefined {
  const ruleSet = reviewRuleSetSchema.parse(rawRuleSet);
  const fingerprint = differenceFingerprint(difference);
  return ruleSet.rules
    .filter(
      (rule) =>
        rule.workflow === report.source.workflow &&
        rule.layer === difference.layer &&
        rule.path === difference.path &&
        (rule.scope === "path" || rule.fingerprint === fingerprint),
    )
    .sort((left, right) => {
      const scopeOrder = Number(right.scope === "exact") - Number(left.scope === "exact");
      return scopeOrder || right.updatedAt.localeCompare(left.updatedAt);
    })[0];
}

export function adjudicateComparison(report: ComparisonReport, rawRuleSet: ReviewRuleSet): ReviewResult {
  const ruleSet = reviewRuleSetSchema.parse(rawRuleSet);
  const differences = report.differences.map((difference) => {
    const rule = matchingRule(report, difference, ruleSet);
    const decision: ReviewDecision = rule?.decision ?? "unresolved";
    return {
      difference,
      fingerprint: differenceFingerprint(difference),
      decision,
      accepted: acceptedDecisions.has(decision),
      ...(rule ? { rule } : {}),
    };
  });
  const reviewed = differences.filter(({ rule }) => Boolean(rule)).length;
  const accepted = differences.filter(({ accepted: isAccepted }) => isAccepted).length;
  const actionable = differences.filter(({ decision }) => decision === "fix-replica").length;
  const unresolved = differences.length - accepted - actionable;
  const byDecision: Record<string, number> = {};
  for (const item of differences) byDecision[item.decision] = (byDecision[item.decision] ?? 0) + 1;
  const adjustedMatched = Math.min(report.checks.total, report.checks.matched + accepted);
  return reviewResultSchema.parse({
    schemaVersion: REVIEW_SCHEMA_VERSION,
    comparisonId: report.comparisonId,
    workflow: report.source.workflow,
    rulesDigest: stableHash(ruleSet),
    originalParityScore: report.parityScore,
    adjustedParityScore: report.checks.total ? adjustedMatched / report.checks.total : 1,
    counts: {
      totalDifferences: differences.length,
      reviewed,
      accepted,
      actionable,
      unresolved,
      byDecision,
    },
    differences,
  });
}

export function upsertReviewRule(
  rawRuleSet: ReviewRuleSet,
  report: ComparisonReport,
  difference: Difference,
  input: {
    decision: ReviewDecision;
    scope: ReviewRuleScope;
    note: string;
    reviewer: string;
  },
  now = new Date().toISOString(),
): { ruleSet: ReviewRuleSet; rule: ReviewRule } {
  const ruleSet = reviewRuleSetSchema.parse(rawRuleSet);
  const fingerprint = input.scope === "exact" ? differenceFingerprint(difference) : undefined;
  const existing = ruleSet.rules.find(
    (rule) =>
      rule.workflow === report.source.workflow &&
      rule.layer === difference.layer &&
      rule.path === difference.path &&
      rule.scope === input.scope &&
      rule.fingerprint === fingerprint,
  );
  const rule: ReviewRule = {
    id: existing?.id ?? `review-rule-${randomUUID()}`,
    workflow: report.source.workflow,
    layer: difference.layer,
    path: difference.path,
    scope: input.scope,
    ...(fingerprint ? { fingerprint } : {}),
    decision: input.decision,
    note: input.note,
    reviewer: input.reviewer,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  const rules = existing
    ? ruleSet.rules.map((candidate) => (candidate.id === existing.id ? rule : candidate))
    : [...ruleSet.rules, rule];
  return {
    rule,
    ruleSet: reviewRuleSetSchema.parse({ ...ruleSet, updatedAt: now, rules }),
  };
}
