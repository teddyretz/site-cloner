import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
  type Request,
} from "playwright-core";
import {
  TRACE_SCHEMA_VERSION,
  capturePolicySchema,
  databaseAdapterSchema,
  manualEventSchema,
  recordedActionSchema,
  recordingManifestSchema,
  type CapturePolicy,
  type ConsoleEntry,
  type DatabaseAdapter,
  type DatabaseSnapshot,
  type ManualEvent,
  type NetworkExchange,
  type PageSnapshot,
  type RecordedAction,
  type RecordedStep,
  type RecordingManifest,
  type SettlementResult,
  type WorkflowScript,
} from "../observation/schema.ts";
import {
  parseAndRedactBody,
  redactHeaders,
  redactJson,
  redactText,
  redactUrl,
  sanitizeHtml,
  stableHash,
} from "../observation/normalize.ts";
import { diffDatabase, fetchDatabaseSnapshot } from "../observation/database.ts";
import { assertActionAllowed, assertUrlAllowed, policyDigest } from "../observation/policy.ts";

const DEFAULT_CHROME_PATH =
  process.env.REPLICATOR_CHROME_EXECUTABLE ??
  (process.platform === "darwin"
    ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    : process.platform === "win32"
      ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
      : "/usr/bin/google-chrome");

export type RecorderOptions = {
  sourceUrl: string;
  workflow: string;
  outputRoot: string;
  policy: CapturePolicy;
  headless?: boolean;
  chromeExecutable?: string;
  databaseSnapshotUrl?: string;
  databaseAdapter?: DatabaseAdapter;
};

export type RecordingResult = {
  runDirectory: string;
  manifest: RecordingManifest;
};

type PendingNetwork = {
  exchange: NetworkExchange;
};

type SettlementOutcome = {
  result: SettlementResult;
  databaseSnapshot?: DatabaseSnapshot;
};

type ManualPayload = {
  monotonicMs: number;
  action: unknown;
};

export class BrowserRecorder {
  private readonly options: RecorderOptions & { headless: boolean; chromeExecutable: string };
  private readonly policy: CapturePolicy;
  private readonly databaseAdapter?: DatabaseAdapter;
  private readonly runId: string;
  private readonly runDirectory: string;
  private readonly snapshotsDirectory: string;
  private readonly network: NetworkExchange[] = [];
  private readonly consoleEntries: ConsoleEntry[] = [];
  private readonly steps: RecordedStep[] = [];
  private readonly snapshots: PageSnapshot[] = [];
  private readonly manualEvents: ManualEvent[] = [];
  private readonly requestMap = new Map<Request, PendingNetwork>();
  private readonly inFlightRequests = new Set<Request>();
  private readonly pendingCaptureTasks = new Set<Promise<void>>();
  private readonly attachedPages = new WeakSet<Page>();
  private readonly pageIds = new WeakMap<Page, string>();
  private readonly manualEventPages = new Map<number, Page>();
  private readonly startedAt = new Date().toISOString();
  private previousSnapshot?: PageSnapshot;
  private previousDatabase?: DatabaseSnapshot;
  private networkCursor = 0;
  private consoleCursor = 0;
  private snapshotIndex = 0;
  private browserVersion = "unknown";
  private pageCounter = 0;
  private currentCorrelationId?: string;
  private lastNetworkActivityMs = Date.now();
  private manualProcessedEvents = 0;
  private manualDrain: Promise<void> = Promise.resolve();
  private manualRecordingActive = false;

  constructor(options: RecorderOptions) {
    this.policy = capturePolicySchema.parse(options.policy);
    this.databaseAdapter = options.databaseAdapter ? databaseAdapterSchema.parse(options.databaseAdapter) : undefined;
    this.options = {
      ...options,
      policy: this.policy,
      databaseAdapter: this.databaseAdapter,
      headless: options.headless ?? false,
      chromeExecutable: options.chromeExecutable ?? DEFAULT_CHROME_PATH,
    };
    assertUrlAllowed(options.sourceUrl, this.policy.allowedOrigins, "source application");
    if (options.databaseSnapshotUrl) {
      assertUrlAllowed(options.databaseSnapshotUrl, this.policy.databaseOrigins, "database snapshot");
      if (!this.databaseAdapter) throw new Error("A database adapter is required with database snapshot capture");
    }
    const safeWorkflow = options.workflow.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    this.runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${safeWorkflow || "workflow"}-${randomUUID().slice(0, 8)}`;
    this.runDirectory = join(options.outputRoot, this.runId);
    this.snapshotsDirectory = join(this.runDirectory, "snapshots");
  }

  async runScript(script: WorkflowScript): Promise<RecordingResult> {
    return this.withBrowser(async (_context, page) => {
      await page.goto(this.options.sourceUrl, { waitUntil: "domcontentloaded" });
      await this.initializeState(page);
      for (const rawAction of script.steps) {
        const action = recordedActionSchema.parse(rawAction);
        assertActionAllowed(action, this.policy);
        await this.recordScriptedAction(page, action);
      }
    });
  }

  async runManual(waitUntilStopped: () => Promise<void>): Promise<RecordingResult> {
    return this.withBrowser(async (context, page) => {
      await context.exposeBinding("__replicatorRecordEvent", (source, payload: unknown) => {
        if (!this.manualRecordingActive) return { accepted: false };
        this.appendManualPayload(source.page, payload);
        this.manualDrain = this.manualDrain.then(() => this.drainManualEvents());
        return { accepted: true };
      });
      await context.addInitScript({ content: manualCaptureScript });
      await page.goto(this.options.sourceUrl, { waitUntil: "domcontentloaded" });
      await this.initializeState(page);
      this.manualRecordingActive = true;
      await waitUntilStopped();
      this.manualRecordingActive = false;
      await this.manualDrain;
      await this.drainManualEvents();
    });
  }

  private async withBrowser(record: (context: BrowserContext, page: Page) => Promise<void>): Promise<RecordingResult> {
    await mkdir(this.snapshotsDirectory, { recursive: true });
    const browser = await chromium.launch({
      headless: this.options.headless,
      executablePath: this.options.chromeExecutable,
    });
    this.browserVersion = browser.version();
    const context = await browser.newContext({
      serviceWorkers: "block",
      viewport: { width: 1440, height: 1000 },
    });
    await this.enforceBrowserPolicy(context);
    context.on("page", (newPage) => {
      this.attachCollectors(newPage);
      if (this.manualRecordingActive) {
        this.appendManualAction(newPage, { kind: "popup", url: redactUrl(newPage.url()), risk: "read" }, 0);
      }
    });
    if (this.policy.rawTrace) {
      await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
    }
    const page = await context.newPage();
    this.attachCollectors(page);

    try {
      await record(context, page);
      await Promise.allSettled([...this.pendingCaptureTasks]);
      if (this.policy.rawTrace) await context.tracing.stop({ path: join(this.runDirectory, "trace.zip") });
      return await this.finalize();
    } finally {
      await this.safeClose(context, browser);
    }
  }

  private async enforceBrowserPolicy(context: BrowserContext): Promise<void> {
    await context.route("**/*", async (route) => {
      const request = route.request();
      try {
        assertUrlAllowed(request.url(), this.policy.allowedOrigins, "browser request");
      } catch {
        await route.abort("blockedbyclient");
        return;
      }
      if (!this.policy.injectCorrelationHeaders || !/^https?:/i.test(request.url())) {
        await route.continue();
        return;
      }
      await route.continue({
        headers: {
          ...request.headers(),
          "x-replicator-run-id": this.runId,
          ...(this.currentCorrelationId ? { "x-replicator-step-id": this.currentCorrelationId } : {}),
        },
      });
    });
  }

  private async safeClose(context: BrowserContext, browser: Browser): Promise<void> {
    await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }

  private attachCollectors(page: Page): void {
    if (this.attachedPages.has(page)) return;
    this.attachedPages.add(page);
    this.pageCounter += 1;
    this.pageIds.set(page, `page-${this.pageCounter}`);
    page.on("console", (message) => {
      this.consoleEntries.push({
        id: `console-${String(this.consoleEntries.length + 1).padStart(4, "0")}`,
        capturedAt: new Date().toISOString(),
        level: message.type(),
        text: redactText(message.text()),
      });
    });
    page.on("framenavigated", (frame) => {
      if (!this.manualRecordingActive || frame !== page.mainFrame()) return;
      const url = frame.url();
      if (!url || url === "about:blank") return;
      this.appendManualAction(page, { kind: "history", url: redactUrl(url), risk: "read" }, 0);
    });
    page.on("request", (request) => {
      this.inFlightRequests.add(request);
      this.lastNetworkActivityMs = Date.now();
      const rawPostData = request.postData();
      const boundedPostData =
        rawPostData && Buffer.byteLength(rawPostData) <= this.policy.limits.responseBodyBytes
          ? rawPostData
          : rawPostData
            ? "[OMITTED:REQUEST_BODY_TOO_LARGE]"
            : null;
      const exchange: NetworkExchange = {
        id: `network-${String(this.network.length + 1).padStart(4, "0")}`,
        startedAt: new Date().toISOString(),
        correlationId: this.currentCorrelationId,
        method: request.method(),
        url: redactUrl(request.url()),
        resourceType: request.resourceType(),
        requestHeaders: redactHeaders(request.headers()),
        requestBody: parseAndRedactBody(boundedPostData),
      };
      this.network.push(exchange);
      this.requestMap.set(request, { exchange });
    });
    page.on("response", (response) => {
      this.lastNetworkActivityMs = Date.now();
      this.trackTask(
        this.captureResponse(response.request(), response.status(), response.headers(), async () => response.body()),
      );
    });
    page.on("requestfinished", (request) => this.finishRequest(request));
    page.on("requestfailed", (request) => {
      const pending = this.requestMap.get(request);
      if (pending) pending.exchange.failure = request.failure()?.errorText ?? "Request failed";
      this.finishRequest(request);
    });
  }

  private finishRequest(request: Request): void {
    this.inFlightRequests.delete(request);
    this.lastNetworkActivityMs = Date.now();
    const pending = this.requestMap.get(request);
    if (pending) pending.exchange.completedAt ??= new Date().toISOString();
  }

  private trackTask(task: Promise<void>): void {
    this.pendingCaptureTasks.add(task);
    void task.finally(() => this.pendingCaptureTasks.delete(task));
  }

  private async captureResponse(
    request: Request,
    status: number,
    headers: Record<string, string>,
    body: () => Promise<Buffer>,
  ): Promise<void> {
    const pending = this.requestMap.get(request);
    if (!pending) return;
    pending.exchange.status = status;
    pending.exchange.responseHeaders = redactHeaders(headers);
    const contentType = headers["content-type"] ?? "";
    const rawLength = headers["content-length"];
    const contentLength = rawLength ? Number(rawLength) : Number.NaN;
    const isText = /json|text|javascript|xml|x-www-form-urlencoded/i.test(contentType);
    if (!isText) {
      pending.exchange.responseBodyOmitted = "not-text";
      return;
    }
    if (!Number.isFinite(contentLength)) {
      pending.exchange.responseBodyOmitted = "unknown-size";
      return;
    }
    if (contentLength > this.policy.limits.responseBodyBytes) {
      pending.exchange.responseBodyOmitted = "too-large";
      return;
    }
    try {
      const bytes = await body();
      if (bytes.byteLength <= this.policy.limits.responseBodyBytes) {
        pending.exchange.responseBody = parseAndRedactBody(bytes.toString("utf8"));
      } else {
        pending.exchange.responseBodyOmitted = "too-large";
      }
    } catch {
      pending.exchange.responseBodyOmitted = "unavailable";
    }
  }

  private async initializeState(page: Page): Promise<void> {
    this.previousDatabase = await this.fetchDatabase();
    this.previousSnapshot = await this.capturePageSnapshot(page, "initial");
    this.networkCursor = this.network.length;
    this.consoleCursor = this.consoleEntries.length;
  }

  private async recordScriptedAction(page: Page, action: RecordedAction): Promise<void> {
    const startedAt = new Date().toISOString();
    const correlationId = `step-${String(this.steps.length + 1).padStart(4, "0")}-${randomUUID().slice(0, 8)}`;
    this.currentCorrelationId = correlationId;
    await this.performAction(page, action);
    const settlement = await this.waitForSettlement(page, correlationId);
    await this.captureStep(page, [action], startedAt, correlationId, settlement);
    this.currentCorrelationId = undefined;
  }

  private appendManualPayload(page: Page, payload: unknown): void {
    if (!payload || typeof payload !== "object") throw new Error("Manual event payload must be an object");
    const input = payload as ManualPayload;
    const action = recordedActionSchema.parse(input.action);
    assertActionAllowed(action, this.policy);
    this.appendManualAction(page, action, input.monotonicMs);
  }

  private appendManualAction(page: Page, action: RecordedAction, monotonicMs: number): void {
    if (this.manualEvents.length >= this.policy.limits.manualEvents) {
      throw new Error(`Manual event limit of ${this.policy.limits.manualEvents} exceeded`);
    }
    const sequence = this.manualEvents.length + 1;
    const event = manualEventSchema.parse({
      sequence,
      capturedAt: new Date().toISOString(),
      monotonicMs: Number.isFinite(monotonicMs) && monotonicMs >= 0 ? monotonicMs : 0,
      pageId: this.pageIds.get(page) ?? "page-unknown",
      action: redactJson(action),
    });
    this.manualEvents.push(event);
    this.manualEventPages.set(sequence, page);
  }

  private async drainManualEvents(): Promise<void> {
    if (this.manualProcessedEvents >= this.manualEvents.length) return;
    const firstIndex = this.manualProcessedEvents;
    const first = this.manualEvents[firstIndex];
    if (!first) return;
    const correlationId = `step-${String(this.steps.length + 1).padStart(4, "0")}-${randomUUID().slice(0, 8)}`;
    this.currentCorrelationId = correlationId;
    const initialLast = this.manualEvents.at(-1);
    const page = this.manualEventPages.get(initialLast?.sequence ?? first.sequence);
    if (!page || page.isClosed()) throw new Error("Manual event page closed before its evidence could be captured");
    const settlement = await this.waitForSettlement(page, correlationId);
    const finalLast = this.manualEvents.at(-1) ?? first;
    const events = this.manualEvents.slice(firstIndex, finalLast.sequence);
    await this.captureStep(
      page,
      events.map(({ action }) => action),
      first.capturedAt,
      correlationId,
      settlement,
      { firstSequence: first.sequence, lastSequence: finalLast.sequence },
    );
    this.manualProcessedEvents = finalLast.sequence;
    this.currentCorrelationId = undefined;
  }

  private async waitForSettlement(page: Page, correlationId: string): Promise<SettlementOutcome> {
    const rule = this.policy.settlement;
    const startedMs = Date.now();
    const startedAt = new Date(startedMs).toISOString();
    let latestDatabase = this.previousDatabase;
    let previousDatabaseHash = latestDatabase ? stableHash(latestDatabase) : undefined;
    let databaseStablePolls = 0;

    while (Date.now() - startedMs < rule.timeoutMs) {
      await page
        .evaluate(
          () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
        )
        .catch(() => undefined);
      if (this.options.databaseSnapshotUrl) {
        latestDatabase = await this.fetchDatabase(correlationId);
        const currentHash = latestDatabase ? stableHash(latestDatabase) : undefined;
        databaseStablePolls = currentHash === previousDatabaseHash ? databaseStablePolls + 1 : 0;
        previousDatabaseHash = currentHash;
      }
      const elapsed = Date.now() - startedMs;
      const networkQuiet =
        this.inFlightRequests.size === 0 && Date.now() - Math.max(this.lastNetworkActivityMs, startedMs) >= rule.quietWindowMs;
      const databaseStable = !this.options.databaseSnapshotUrl || databaseStablePolls >= rule.databaseStablePolls;
      if (elapsed >= rule.minimumObservationMs && networkQuiet && databaseStable) {
        return {
          result: {
            status: "settled",
            startedAt,
            completedAt: new Date().toISOString(),
            durationMs: elapsed,
            outstandingRequests: this.inFlightRequests.size,
            databaseStablePolls,
          },
          databaseSnapshot: latestDatabase,
        };
      }
      await page.waitForTimeout(rule.databasePollIntervalMs);
    }
    const completedMs = Date.now();
    return {
      result: {
        status: "timed-out",
        startedAt,
        completedAt: new Date(completedMs).toISOString(),
        durationMs: completedMs - startedMs,
        outstandingRequests: this.inFlightRequests.size,
        databaseStablePolls,
      },
      databaseSnapshot: latestDatabase,
    };
  }

  private async captureStep(
    page: Page,
    actions: RecordedAction[],
    startedAt: string,
    correlationId: string,
    settlement: SettlementOutcome,
    manualEventRange?: RecordedStep["manualEventRange"],
  ): Promise<void> {
    if (!this.previousSnapshot) throw new Error("Recorder state was not initialized");
    await Promise.allSettled([...this.pendingCaptureTasks]);
    const afterSnapshot = await this.capturePageSnapshot(page, `step-${this.steps.length + 1}`);
    const afterDatabase = settlement.databaseSnapshot ?? (await this.fetchDatabase(correlationId));
    const databaseChanges = diffDatabase(this.previousDatabase, afterDatabase, this.databaseAdapter);
    const newNetwork = this.network.slice(this.networkCursor);
    const newConsole = this.consoleEntries.slice(this.consoleCursor);
    this.steps.push({
      index: this.steps.length,
      correlationId,
      startedAt,
      completedAt: new Date().toISOString(),
      actions: actions.map((action) => recordedActionSchema.parse(redactJson(action))),
      manualEventRange,
      settlement: settlement.result,
      beforeSnapshotId: this.previousSnapshot.id,
      afterSnapshotId: afterSnapshot.id,
      networkExchangeIds: newNetwork.map(({ id }) => id),
      consoleEntryIds: newConsole.map(({ id }) => id),
      databaseChanges,
    });
    this.previousSnapshot = afterSnapshot;
    this.previousDatabase = afterDatabase;
    this.networkCursor = this.network.length;
    this.consoleCursor = this.consoleEntries.length;
  }

  private async capturePageSnapshot(page: Page, label: string): Promise<PageSnapshot> {
    this.snapshotIndex += 1;
    const id = `snapshot-${String(this.snapshotIndex).padStart(4, "0")}`;
    const baseName = `${String(this.snapshotIndex).padStart(4, "0")}-${label}`;
    const domPath = join(this.snapshotsDirectory, `${baseName}.html`);
    const screenshotPath = join(this.snapshotsDirectory, `${baseName}.png`);
    const [title, visibleText, aria, html] = await Promise.all([
      page.title(),
      page.locator("body").innerText().then(redactText).catch(() => ""),
      page.ariaSnapshot({ timeout: 5_000 }).then(redactText).catch(() => ""),
      this.captureSanitizedDom(page),
    ]);
    let relativeScreenshotPath: string | undefined;
    if (this.policy.screenshots) {
      const mask = this.policy.maskSelectors.map((selector) => page.locator(selector));
      await page.screenshot({ path: screenshotPath, fullPage: true, mask, maskColor: "#000000" });
      relativeScreenshotPath = relative(this.runDirectory, screenshotPath);
    }
    await writeFile(domPath, sanitizeHtml(html), "utf8");
    const snapshot: PageSnapshot = {
      id,
      capturedAt: new Date().toISOString(),
      url: redactUrl(page.url()),
      title: redactText(title),
      visibleText,
      aria,
      domPath: relative(this.runDirectory, domPath),
      screenshotPath: relativeScreenshotPath,
    };
    this.snapshots.push(snapshot);
    return snapshot;
  }

  private async captureSanitizedDom(page: Page): Promise<string> {
    return page.evaluate(
      ({ maskSelectors, redacted }) => {
        const clone = document.documentElement.cloneNode(true) as HTMLElement;
        clone.querySelectorAll("script, noscript").forEach((node) => node.remove());
        clone.querySelectorAll("input, textarea").forEach((node) => {
          node.setAttribute("value", "");
          if (node instanceof HTMLTextAreaElement) node.textContent = "";
        });
        for (const selector of maskSelectors) {
          try {
            clone.querySelectorAll(selector).forEach((node) => {
              node.textContent = redacted;
              node.setAttribute("value", redacted);
            });
          } catch {
            // Invalid selectors are ignored in the clone; screenshot capture will fail them explicitly.
          }
        }
        return `<!doctype html>${clone.outerHTML}`;
      },
      { maskSelectors: this.policy.maskSelectors, redacted: "[REDACTED]" },
    );
  }

  private resolveLocator(page: Page, action: RecordedAction): Locator {
    const target = action.target;
    if (!target) throw new Error(`${action.kind} requires a target`);
    if (target.label) return page.getByLabel(target.label, { exact: true });
    if (target.role) {
      return page.getByRole(target.role as Parameters<Page["getByRole"]>[0], {
        name: target.name,
        exact: target.name !== undefined,
      });
    }
    if (target.testId) return page.getByTestId(target.testId);
    if (target.css) return page.locator(target.css);
    throw new Error(`Target for ${action.kind} has no usable semantic locator`);
  }

  private async performAction(page: Page, action: RecordedAction): Promise<void> {
    if (action.kind === "navigate") {
      if (!action.url) throw new Error("navigate requires url");
      const url = new URL(action.url, this.options.sourceUrl).toString();
      assertUrlAllowed(url, this.policy.allowedOrigins, "navigation");
      await page.goto(url, { waitUntil: "domcontentloaded" });
      return;
    }
    if (["history", "popup"].includes(action.kind)) throw new Error(`${action.kind} is observable but not scriptable`);
    const locator = this.resolveLocator(page, action);
    switch (action.kind) {
      case "click":
      case "submit":
        await locator.click();
        break;
      case "fill":
        await locator.fill(action.value ?? "");
        break;
      case "select":
        await locator.selectOption(action.value ?? "");
        break;
      case "check":
        await locator.check();
        break;
      case "uncheck":
        await locator.uncheck();
        break;
      case "press":
        await locator.press(action.key ?? "Enter");
        break;
      case "upload":
        throw new Error("Scripted uploads require an explicit future fixture-file policy");
    }
  }

  private async fetchDatabase(correlationId?: string): Promise<DatabaseSnapshot | undefined> {
    return fetchDatabaseSnapshot({
      url: this.options.databaseSnapshotUrl,
      allowedOrigins: this.policy.databaseOrigins,
      maxBytes: this.policy.limits.databaseSnapshotBytes,
      maxRowsPerTable: this.policy.limits.databaseRowsPerTable,
      runId: this.runId,
      correlationId,
    });
  }

  private async finalize(): Promise<RecordingResult> {
    const completedAt = new Date().toISOString();
    await Promise.all([
      writeFile(join(this.runDirectory, "actions.jsonl"), toJsonLines(this.steps), "utf8"),
      writeFile(join(this.runDirectory, "snapshots.jsonl"), toJsonLines(this.snapshots), "utf8"),
      writeFile(join(this.runDirectory, "network.jsonl"), toJsonLines(this.network), "utf8"),
      writeFile(join(this.runDirectory, "console.jsonl"), toJsonLines(this.consoleEntries), "utf8"),
      writeFile(join(this.runDirectory, "manual-events.jsonl"), toJsonLines(this.manualEvents), "utf8"),
    ]);
    const manifest = recordingManifestSchema.parse({
      schemaVersion: TRACE_SCHEMA_VERSION,
      runId: this.runId,
      workflow: this.options.workflow,
      sourceUrl: redactUrl(this.options.sourceUrl),
      startedAt: this.startedAt,
      completedAt,
      policy: this.policy,
      policyDigest: policyDigest(this.policy),
      databaseAdapterDigest: this.databaseAdapter ? stableHash(this.databaseAdapter) : undefined,
      browser: { name: "chromium", version: this.browserVersion, headless: this.options.headless },
      capture: {
        ui: true,
        network: true,
        database: Boolean(this.options.databaseSnapshotUrl),
        externalEvents: false,
        screenshots: this.policy.screenshots,
        rawTrace: this.policy.rawTrace,
      },
      counts: {
        steps: this.steps.length,
        snapshots: this.snapshots.length,
        networkExchanges: this.network.length,
        consoleEntries: this.consoleEntries.length,
        databaseChanges: this.steps.reduce((total, step) => total + step.databaseChanges.length, 0),
        manualEvents: this.manualEvents.length,
      },
      files: {
        actions: "actions.jsonl",
        snapshots: "snapshots.jsonl",
        network: "network.jsonl",
        console: "console.jsonl",
        manualEvents: "manual-events.jsonl",
        trace: this.policy.rawTrace ? "trace.zip" : undefined,
      },
    });
    await writeFile(join(this.runDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    return { runDirectory: this.runDirectory, manifest };
  }
}

function toJsonLines(values: unknown[]): string {
  return values.map((value) => JSON.stringify(value)).join("\n") + (values.length ? "\n" : "");
}

const manualCaptureScript = String.raw`
(() => {
  const REDACTED = "[REDACTED]";
  const sensitive = /password|passwd|secret|token|api[-_]?key|session|credential|cvv|ssn|cc-/i;
  const timers = new WeakMap();
  const send = (action) => {
    const bridge = window.__replicatorRecordEvent;
    if (typeof bridge === "function") void bridge({ monotonicMs: performance.now(), action });
  };
  const text = (value) => (value || "").replace(/\s+/g, " ").trim().slice(0, 160);
  const targetFor = (element) => {
    const label = element.labels?.[0] ? text(element.labels[0].innerText) : undefined;
    const role = element.getAttribute("role") || ({ BUTTON: "button", A: "link", INPUT: "textbox", SELECT: "combobox", TEXTAREA: "textbox" }[element.tagName]);
    const name = text(element.getAttribute("aria-label") || element.innerText || element.getAttribute("placeholder"));
    const testId = element.getAttribute("data-testid") || undefined;
    const css = element.id ? "#" + CSS.escape(element.id) : undefined;
    return { role, name: name || undefined, label, testId, css };
  };
  const inputAction = (element) => {
    const descriptor = [element.type, element.name, element.id, element.autocomplete].join(" ");
    if (element instanceof HTMLInputElement && element.type === "file") {
      return { kind: "upload", target: targetFor(element), value: "[FILES:" + (element.files?.length || 0) + "]", risk: "write" };
    }
    const value = sensitive.test(descriptor) ? REDACTED : element.value;
    let kind = element instanceof HTMLSelectElement ? "select" : "fill";
    if (element instanceof HTMLInputElement && (element.type === "checkbox" || element.type === "radio")) kind = element.checked ? "check" : "uncheck";
    return { kind, target: targetFor(element), value, risk: "read" };
  };
  document.addEventListener("click", (event) => {
    const element = event.target?.closest?.("button, a, [role=button], [role=link]");
    if (!element) return;
    send({ kind: "click", target: targetFor(element), risk: "write" });
  }, true);
  document.addEventListener("input", (event) => {
    const element = event.target;
    if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement)) return;
    clearTimeout(timers.get(element));
    timers.set(element, setTimeout(() => send(inputAction(element)), 150));
  }, true);
  document.addEventListener("change", (event) => {
    const element = event.target;
    if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement)) return;
    clearTimeout(timers.get(element));
    send(inputAction(element));
  }, true);
  document.addEventListener("submit", (event) => {
    send({ kind: "submit", target: targetFor(event.target), risk: "write" });
  }, true);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.metaKey || event.ctrlKey || event.altKey) {
      send({ kind: "press", target: targetFor(event.target), key: event.key, risk: "read" });
    }
  }, true);
})();
`;
