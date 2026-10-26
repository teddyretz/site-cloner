import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ReviewResult } from "./schema.ts";

export async function writeReviewResult(
  result: ReviewResult,
  outputDirectory: string,
): Promise<{ jsonPath: string; markdownPath: string }> {
  await mkdir(outputDirectory, { recursive: true });
  const jsonPath = join(outputDirectory, "review.json");
  const markdownPath = join(outputDirectory, "review.md");
  await Promise.all([
    writeFile(jsonPath, `${JSON.stringify(result, null, 2)}\n`, "utf8"),
    writeFile(markdownPath, renderReviewMarkdown(result), "utf8"),
  ]);
  return { jsonPath, markdownPath };
}

export function renderReviewMarkdown(result: ReviewResult): string {
  const lines = [
    `# Review: ${result.workflow}`,
    "",
    `- Observed parity: **${(result.originalParityScore * 100).toFixed(1)}%**`,
    `- Accepted-difference parity: **${(result.adjustedParityScore * 100).toFixed(1)}%**`,
    `- Reviewed: **${result.counts.reviewed}/${result.counts.totalDifferences}**`,
    `- Must fix: **${result.counts.actionable}**`,
    `- Unresolved: **${result.counts.unresolved}**`,
    "",
    "## Decisions",
    "",
  ];
  if (!result.differences.length) lines.push("No differences were observed.", "");
  for (const item of result.differences) {
    lines.push(
      `### ${item.difference.id}: ${item.difference.summary}`,
      "",
      `- Decision: **${item.decision}**`,
      `- Layer: ${item.difference.layer}`,
      `- Path: \`${item.difference.path}\``,
      `- Rule: ${item.rule ? `${item.rule.scope} (${item.rule.reviewer})` : "none"}`,
      ...(item.rule?.note ? [`- Note: ${item.rule.note}`] : []),
      "",
    );
  }
  return lines.join("\n");
}
