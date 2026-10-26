import { defineTool } from "eve/tools";
import { z } from "zod";
import { loadRecording, resolveRunDirectory } from "../../src/observation/artifacts.ts";

const outputSchema = z.object({
  runId: z.string(),
  workflow: z.string(),
  sourceUrl: z.string(),
  counts: z.object({
    steps: z.number(),
    snapshots: z.number(),
    networkExchanges: z.number(),
    consoleEntries: z.number(),
    databaseChanges: z.number(),
    manualEvents: z.number(),
  }),
  actions: z.array(z.object({ index: z.number(), kinds: z.array(z.string()), databaseChanges: z.number() })),
});

export default defineTool({
  description: "Inspect a local authorized workflow recording by run ID and summarize its captured evidence.",
  inputSchema: z.object({
    runId: z.string().regex(/^[a-zA-Z0-9._-]+$/),
  }),
  outputSchema,
  label: {
    start: ({ runId }) => `Inspect recording ${runId}`,
  },
  async execute({ runId }) {
    const directory = await resolveRunDirectory(process.env.REPLICATOR_RUNS_DIR ?? "artifacts/runs", runId);
    const bundle = await loadRecording(directory);
    return {
      runId: bundle.manifest.runId,
      workflow: bundle.manifest.workflow,
      sourceUrl: bundle.manifest.sourceUrl,
      counts: bundle.manifest.counts,
      actions: bundle.steps.map((step) => ({
        index: step.index,
        kinds: step.actions.map(({ kind }) => kind),
        databaseChanges: step.databaseChanges.length,
      })),
    };
  },
});
