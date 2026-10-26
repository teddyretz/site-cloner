import { randomBytes } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { comparisonReportSchema, type ComparisonReport } from "../diff/schema.ts";
import { adjudicateComparison, upsertReviewRule } from "./adjudicate.ts";
import { reviewDecisionInputSchema } from "./schema.ts";
import { loadRuleSet, updateRuleSet } from "./store.ts";
import { renderReviewUi } from "./ui.ts";

const MAX_REPORT_BYTES = 50 * 1024 * 1024;
const MAX_REQUEST_BYTES = 64 * 1024;

export type ReviewServer = {
  url: string;
  close(): Promise<void>;
};

export async function loadComparisonReport(path: string): Promise<ComparisonReport> {
  const absolute = resolve(path);
  const metadata = await lstat(absolute);
  if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error("Comparison report must be a real file");
  if (metadata.size > MAX_REPORT_BYTES) throw new Error("Comparison report is too large");
  return comparisonReportSchema.parse(JSON.parse(await readFile(await realpath(absolute), "utf8")));
}

export async function startReviewServer(options: {
  reportPath: string;
  rulesPath: string;
  port?: number;
}): Promise<ReviewServer> {
  const report = await loadComparisonReport(options.reportPath);
  const token = randomBytes(24).toString("hex");
  const nonce = randomBytes(18).toString("base64");
  const state = async () => {
    const review = adjudicateComparison(report, await loadRuleSet(options.rulesPath));
    return {
      report: {
        comparisonId: report.comparisonId,
        workflow: report.source.workflow,
        sourceRunId: report.source.runId,
        replicaRunId: report.replica.runId,
      },
      review,
    };
  };
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/") {
        if (url.searchParams.get("token") !== token) return json(response, 403, { error: "Invalid review link" });
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
        });
        response.end(renderReviewUi(token, nonce));
        return;
      }
      if (request.headers["x-replicator-review-token"] !== token) {
        return json(response, 403, { error: "Invalid review token" });
      }
      if (request.method === "GET" && url.pathname === "/api/review") return json(response, 200, await state());
      if (request.method === "POST" && url.pathname === "/api/decision") {
        const input = reviewDecisionInputSchema.parse(await readJsonBody(request));
        const difference = report.differences.find(({ id }) => id === input.differenceId);
        if (!difference) return json(response, 404, { error: "Difference not found" });
        await updateRuleSet(options.rulesPath, (ruleSet) => {
          const updated = upsertReviewRule(ruleSet, report, difference, input);
          return { ruleSet: updated.ruleSet, result: updated.rule };
        });
        return json(response, 200, await state());
      }
      return json(response, 404, { error: "Not found" });
    } catch (error) {
      return json(response, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  });
  await new Promise<void>((resolveListening, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => resolveListening());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Review server did not bind to a TCP port");
  return {
    url: `http://127.0.0.1:${address.port}/?token=${token}`,
    close: () => new Promise<void>((resolveClose, reject) => server.close((error) => (error ? reject(error) : resolveClose()))),
  };
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > MAX_REQUEST_BYTES) throw new Error("Review request is too large");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function json(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}
