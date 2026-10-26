import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createEmptyRuleSet } from "./adjudicate.ts";
import { reviewRuleSetSchema, type ReviewRuleSet } from "./schema.ts";

const MAX_RULE_FILE_BYTES = 25 * 1024 * 1024;
const LOCK_TIMEOUT_MS = 5_000;
const STALE_LOCK_MS = 30_000;

export async function loadRuleSet(path: string): Promise<ReviewRuleSet> {
  const absolute = resolve(path);
  try {
    const metadata = await stat(absolute);
    if (!metadata.isFile()) throw new Error("Review rule path is not a file");
    if (metadata.size > MAX_RULE_FILE_BYTES) throw new Error("Review rule file is too large");
    return reviewRuleSetSchema.parse(JSON.parse(await readFile(absolute, "utf8")));
  } catch (error) {
    if (isMissing(error)) return createEmptyRuleSet();
    throw error;
  }
}

export async function saveRuleSet(path: string, rawRuleSet: ReviewRuleSet): Promise<void> {
  const ruleSet = reviewRuleSetSchema.parse(rawRuleSet);
  const absolute = resolve(path);
  await mkdir(dirname(absolute), { recursive: true });
  const temporary = `${absolute}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(ruleSet, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, absolute);
}

export async function updateRuleSet<T>(
  path: string,
  update: (current: ReviewRuleSet) => Promise<{ ruleSet: ReviewRuleSet; result: T }> | { ruleSet: ReviewRuleSet; result: T },
): Promise<T> {
  const absolute = resolve(path);
  await mkdir(dirname(absolute), { recursive: true });
  return withFileLock(`${absolute}.lock`, async () => {
    const current = await loadRuleSet(absolute);
    const next = await update(current);
    await saveRuleSet(absolute, next.ruleSet);
    return next.result;
  });
}

async function withFileLock<T>(lockPath: string, work: () => Promise<T>): Promise<T> {
  const started = Date.now();
  while (true) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(`${process.pid}\n`, "utf8");
        return await work();
      } finally {
        await handle.close();
        await unlink(lockPath).catch(() => undefined);
      }
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      const lock = await stat(lockPath).catch(() => undefined);
      if (lock && Date.now() - lock.mtimeMs > STALE_LOCK_MS) {
        await unlink(lockPath).catch(() => undefined);
        continue;
      }
      if (Date.now() - started >= LOCK_TIMEOUT_MS) throw new Error("Timed out waiting for the review rule store");
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
    }
  }
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function isAlreadyExists(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "EEXIST");
}
