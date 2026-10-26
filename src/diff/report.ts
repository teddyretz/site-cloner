import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ComparisonReport } from "./schema.ts";

export async function writeComparisonReport(
  report: ComparisonReport,
  outputRoot: string,
): Promise<{ directory: string; jsonPath: string; markdownPath: string }> {
  const directory = join(outputRoot, report.comparisonId);
  await mkdir(directory, { recursive: true });
  const jsonPath = join(directory, "comparison.json");
  const markdownPath = join(directory, "report.md");
  await Promise.all([
    writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8"),
    writeFile(markdownPath, renderMarkdown(report), "utf8"),
  ]);
  return { directory, jsonPath, markdownPath };
}

export function renderMarkdown(report: ComparisonReport): string {
  const percent = (report.parityScore * 100).toFixed(1);
  const lines = [
    `# Differential report: ${report.source.workflow}`,
    "",
    `- Parity: **${percent}%** (${report.checks.matched}/${report.checks.total} checks)`,
    `- Source run: \`${report.source.runId}\``,
    `- Replica run: \`${report.replica.runId}\``,
    `- Differences: **${report.counts.differences}**`,
    "",
  ];
  if (!report.differences.length) {
    lines.push("All normalized semantic UI, API, and database checks matched.", "");
    return lines.join("\n");
  }
  lines.push("## Differences", "");
  for (const difference of report.differences) {
    lines.push(
      `### ${difference.id}: ${difference.summary}`,
      "",
      `- Step: ${difference.stepIndex}`,
      `- Layer: ${difference.layer}`,
      `- Classification: ${difference.classification}`,
      `- Path: \`${difference.path}\``,
      "",
      "```json",
      JSON.stringify({ expected: difference.expected, actual: difference.actual }, null, 2).slice(0, 8_000),
      "```",
      "",
    );
  }
  return lines.join("\n");
}
