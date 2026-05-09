/**
 * AC2: No shell evaluation in gstack-issue-artifact.
 *
 * Statically greps the source for shell invocation patterns that would
 * allow command injection, then dynamically verifies a malicious title
 * does not touch the filesystem.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync, existsSync, mkdtempSync, writeFileSync, readdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const ROOT = join(import.meta.dir, "..");
const ARTIFACT_SRC = join(ROOT, "bin", "gstack-issue-artifact");

describe("issue-artifacts-no-shell (AC2)", () => {
  const source = readFileSync(ARTIFACT_SRC, "utf-8");

  test("source never calls sh -c or /bin/sh", () => {
    expect(source).not.toMatch(/sh\s+-c/);
    expect(source).not.toMatch(/\/bin\/sh/);
  });

  test("source never uses execSync or child_process exec", () => {
    expect(source).not.toMatch(/\bexecSync\b/);
    expect(source).not.toMatch(/\bexec\(/);
    expect(source).not.toMatch(/child_process.*exec\b/);
  });

  test("source never uses template literals in cmd arrays for Bun.spawn", () => {
    // Cmd arrays should use variables directly, not interpolated strings that could be split
    const lines = source.split("\n");
    for (const line of lines) {
      if (line.includes("Bun.spawn") || line.includes("cmd:")) {
        expect(line).not.toMatch(/`.*\$\{.*\}.*`.*,.*`/);
      }
    }
  });

  test("source uses only Bun.spawnSync with cmd arrays", () => {
    const spawnCalls = source.match(/Bun\.spawnSync\s*\(/g) || [];
    expect(spawnCalls.length).toBeGreaterThan(0);

    // Every Bun.spawnSync call must use cmd as an array:
    //   - `cmd: [...]` inline array form, OR
    //   - `{ cmd }` shorthand where `cmd` is a typed `string[]` variable
    let idx = 0;
    for (let i = 0; i < spawnCalls.length; i++) {
      const pos = source.indexOf("Bun.spawnSync(", idx);
      expect(pos).toBeGreaterThanOrEqual(0);
      const snippet = source.slice(pos, pos + 300);
      const hasInlineArray = /cmd\s*:\s*\[/.test(snippet);
      const hasShorthand = /\{\s*cmd\s*\}/.test(snippet);
      expect(hasInlineArray || hasShorthand).toBe(true);
      idx = pos + 1;
    }
  });

  test("malicious title does not execute via filesystem", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "no-shell-test-"));
    const marker = join(tmpDir, "PWNED");
    const bodyFile = join(tmpDir, "body.md");
    writeFileSync(bodyFile, "test body");

    // Craft a malicious title that would create a file if shell-evaluated
    const maliciousTitle = `$(touch ${marker})`;

    const result = Bun.spawnSync({
      cmd: [
        "bun", "run", ARTIFACT_SRC,
        "create",
        "--kind", "ceo-plan",
        "--title", maliciousTitle,
        "--body-file", bodyFile,
      ],
      env: {
        ...process.env,
        PATH: `${join(ROOT, "test", "fixtures", "issue-artifacts")}:${process.env.PATH}`,
        STUB_GH_LEDGER: join(tmpDir, "ledger.jsonl"),
        STUB_GH_SCENARIO: join(ROOT, "test", "fixtures", "issue-artifacts", "scenarios", "foundation-smoke.json"),
      },
    });

    // The marker file must NOT exist — shell expansion did not happen
    expect(existsSync(marker)).toBe(false);
  });
});
