/**
 * AC: spawnWithRetry retries on HTTP 429 / rate-limit stderr, with exponential backoff.
 *
 * Uses a stateful stub (stub-gh-rate-limit) that fails the first N calls
 * with a rate-limit message, then succeeds. Validates:
 *   1. The command eventually succeeds after retries.
 *   2. The stub was called the expected number of times (fail_count + 1).
 *   3. A permanently-failing stub (fail_count > MAX_RETRIES) results in failure.
 */
import { describe, test, expect } from "bun:test";
import { mkdtempSync, readFileSync, symlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const ROOT = join(import.meta.dir, "..");
const ARTIFACT_SRC = join(ROOT, "bin", "gstack-issue-artifact");
const RATE_LIMIT_STUB = join(ROOT, "test", "fixtures", "issue-artifacts", "stub-gh-rate-limit");

function spawnArtifactWithRateLimit(failCount: number, args: string[]) {
  const tmpDir = mkdtempSync(join(tmpdir(), "retry-test-"));
  const counterFile = join(tmpDir, "call-counter");

  // Create a `gh` symlink pointing to our stateful rate-limit stub
  symlinkSync(RATE_LIMIT_STUB, join(tmpDir, "gh"));

  const result = Bun.spawnSync({
    cmd: ["bun", "run", ARTIFACT_SRC, ...args],
    env: {
      ...process.env,
      PATH: `${tmpDir}:${process.env.PATH}`,
      STUB_GH_COUNTER_FILE: counterFile,
      STUB_GH_FAIL_COUNT: String(failCount),
    },
  });

  return { result, counterFile };
}

describe("issue-artifacts retry-on-429", () => {
  test("succeeds after 2 rate-limit failures (within MAX_RETRIES=3)", () => {
    const { result, counterFile } = spawnArtifactWithRateLimit(2, [
      "read", "42",
    ]);

    expect(result.exitCode).toBe(0);
    const stdout = result.stdout.toString();
    expect(stdout).toContain("Test Issue");

    const callCount = parseInt(readFileSync(counterFile, "utf-8").trim(), 10);
    expect(callCount).toBe(3); // 2 failures + 1 success
  });

  test("fails after exhausting MAX_RETRIES=3 retries", () => {
    const { result, counterFile } = spawnArtifactWithRateLimit(10, [
      "read", "42",
    ]);

    expect(result.exitCode).not.toBe(0);

    const callCount = parseInt(readFileSync(counterFile, "utf-8").trim(), 10);
    // MAX_RETRIES=3, so total attempts = 4 (initial + 3 retries)
    expect(callCount).toBe(4);
  }, 15_000);
});
