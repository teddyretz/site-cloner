# Replicator

Replicator is an evidence-first harness for authorized software reimplementation. Trace Contract 0.2 records a workflow as correlated UI, network, console, and optional database evidence behind a machine-enforced capture policy.

## What works now

- Manual recording as a timestamped event journal in a local Chrome window.
- Deterministic scripted recording for tests and CI.
- Persisted and reloadable accessibility snapshots, visible text, sanitized DOM, and masked screenshots.
- Normalized request/response capture with conservative header collection and secret redaction.
- Optional row-level database changes using adapter-defined composite and logical identities.
- Network quiescence, database-stability polling, bounded timeouts, and per-step correlation IDs.
- Enforced browser/database origins, action-risk ceilings, artifact limits, and symlink/path containment.
- A versioned trace schema and an Eve agent tool for inspecting recordings.
- A dual-target runner that replays the same workflow against source and replica applications.
- Normalized, step-aligned UI, API, and row-level data comparisons with JSON and Markdown reports.
- An Eve agent tool for explaining recording differences without exposing captured payloads.
- A local review surface for classifying differences and saving reusable human decisions.
- A deterministic invoice fixture proving the full UI → API → database path.

## Try the fixture

This project requires Node.js 24.

For CI and non-macOS environments, set `REPLICATOR_CHROME_EXECUTABLE` to the installed Chrome or Chromium executable. The GitHub Actions workflow discovers the hosted runner's browser automatically.

Start the local fixture:

```bash
npm run fixture
```

In another terminal, record its seeded workflow:

```bash
npm run record -- \
  --url http://127.0.0.1:4317 \
  --script fixtures/workflows/create-invoice.json \
  --db-snapshot-url http://127.0.0.1:4317/__fixture/db-snapshot \
  --db-adapter fixtures/database-adapter.json \
  --policy fixtures/capture-policy.json
```

The resulting evidence bundle is written under `artifacts/runs/<run-id>/`.

For a human-performed workflow, omit `--script`. Chrome opens, recording begins, and the terminal waits for Enter:

```bash
npm run record -- \
  --url https://authorized-app.example \
  --workflow create-invoice \
  --tenant sandbox-tenant \
  --identity ops-test-user
```

Only use the recorder with systems you own or have explicit permission to test. The current contract intentionally supports only `test-data-only` mode. Do not record production sessions, real customer data, credentials, payment data, or other sensitive information.

Without `--policy`, the CLI creates a narrow policy permitting only the source origin and the explicitly configured database origin. Use a policy file when an application legitimately needs additional origins. Every run stores the policy and its digest. Scripted actions above the policy's risk ceiling are rejected before execution.

Database capture is opt-in and requires both an authorized read-only snapshot endpoint and an adapter declaring primary keys, logical keys, and optional tenant scope for every returned table.

## Evidence bundle

Each run contains:

```text
manifest.json
actions.jsonl
snapshots.jsonl
network.jsonl
console.jsonl
manual-events.jsonl
snapshots/
  0001-initial.html
  0001-initial.png
  ...
```

Raw Playwright traces are disabled by default because they may retain unredacted browser state. They are emitted only when `rawTrace` is explicitly enabled in a test-data policy. Screenshots apply the policy's masking selectors before being written.

## Compare source and replica

Replay the same scripted workflow against two authorized test tenants:

```bash
npm run compare -- \
  --source-url https://source-test.example \
  --replica-url https://replica-test.example \
  --script fixtures/workflows/create-invoice.json \
  --source-tenant source-sandbox \
  --source-identity source-test-user \
  --replica-tenant replica-sandbox \
  --replica-identity replica-test-user \
  --normalization fixtures/normalization-profile.json
```

Add `--source-db-snapshot-url`, `--replica-db-snapshot-url`, and `--db-adapter` to compare row-level effects. Use `--source-policy` and `--replica-policy` when either target needs a custom allowlist or capture policy.

Each comparison writes both evidence bundles plus:

```text
comparison.json
report.md
```

The parity score is computed from step-aligned checks. UI comparison uses routes, accessibility trees, and visible text; API comparison uses normalized requests, status codes, and responses; data comparison uses normalized logical identities and row effects. Timestamps, UUIDs, selected keys, query parameters, database columns, and known UI strings can be normalized through a versioned profile.

Already-recorded runs can be compared without revisiting either application:

```bash
npm run diff -- \
  --source-run artifacts/runs/<source-run-id> \
  --replica-run artifacts/runs/<replica-run-id> \
  --normalization fixtures/normalization-profile.json
```

The runner reports observed equivalence, not source-code equivalence. Missing database capture prevents migration-grade data-parity claims.

## Review differences

Open a finished comparison in the local review surface:

```bash
npm run review -- \
  --report artifacts/comparisons/<comparison-id>/comparison.json
```

The command prints a private localhost link. Open it to inspect source and replica evidence side by side, then classify each difference as:

- **Replica must be fixed** — an actionable incompatibility.
- **Expected difference** — an intentional product difference.
- **Ignore as noise** — nondeterministic or irrelevant evidence.
- **Source app is wrong** — a legacy defect that should not be reproduced.
- **Not decided** — leave the difference unresolved.

Decisions are saved to `artifacts/review-rules.json` by default. The raw comparison report is never modified. Instead, review produces a second metric called **accepted-difference parity** alongside the original observed parity.

Rules default to **exact** scope: they apply only when the layer, path, expected value, and actual value all match. A reviewer can deliberately choose **path** scope to apply the decision to future values at the same workflow check. Exact rules take precedence over broader path rules.

Apply saved rules to a report non-interactively:

```bash
npm run adjudicate -- \
  --report artifacts/comparisons/<comparison-id>/comparison.json \
  --rules artifacts/review-rules.json
```

This writes `review.json` and `review.md` beside the comparison report. Pass `--rules artifacts/review-rules.json` to `compare` or `diff` to generate these reviewed outputs automatically for future runs.

The Eve agent reads the same rule store when it compares recordings. Its `review_difference` tool can save decisions conversationally, but every write requires an explicit human approval prompt. Set `REPLICATOR_RULES_FILE` when the shared rule store lives somewhere other than `artifacts/review-rules.json`.

The next milestone is the behavioral spec compiler: promote repeated traces and reviewed differences into workflow state machines, inferred API contracts, and named data invariants.

## Development

```bash
npm run typecheck
npm test
npm run build
```

Run the Eve agent locally with `npm run dev`. Set `REPLICATOR_RUNS_DIR` when recordings live somewhere other than `artifacts/runs`. The agent can safely summarize a recording or compare two run IDs under that configured root.
