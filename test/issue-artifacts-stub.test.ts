/**
 * AC8: Stub-shim conformance tests.
 *
 * Verifies the stub-gh/stub-glab shims conform to STUB-CONTRACT.md:
 * - Scenario matching and response delivery
 * - Ledger recording format
 * - STUB_GH_LEDGER fail-closed (exit 2 when unset)
 * - Parallel ledger isolation
 */
import { describe, test, expect } from "bun:test";
import { readFileSync, existsSync, mkdtempSync, writeFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const ROOT = join(import.meta.dir, "..");
const FIXTURES = join(ROOT, "test", "fixtures", "issue-artifacts");
const STUB_GH = join(FIXTURES, "stub-gh");
const STUB_GLAB = join(FIXTURES, "stub-glab");
const CONTRACT = join(FIXTURES, "STUB-CONTRACT.md");
const SMOKE_SCENARIO = join(FIXTURES, "scenarios", "foundation-smoke.json");

describe("stub-shim conformance (AC8)", () => {
  test("STUB-CONTRACT.md exists and documents all subcommands", () => {
    expect(existsSync(CONTRACT)).toBe(true);
    const content = readFileSync(CONTRACT, "utf-8");
    for (const cmd of ["create", "update", "read", "comment", "close", "find", "list-by-label", "validate-url", "handoff"]) {
      expect(content).toContain(cmd);
    }
  });

  test("contract documents STUB_GH_LEDGER env var", () => {
    const content = readFileSync(CONTRACT, "utf-8");
    expect(content).toContain("STUB_GH_LEDGER");
    expect(content).toContain("STUB_GLAB_LEDGER");
    expect(content).toContain("refusing to write to a default path");
  });

  test("contract forbids inline argv-parser patches", () => {
    const content = readFileSync(CONTRACT, "utf-8");
    expect(content.toLowerCase()).toMatch(/must not patch|never.*patch|forbid.*patch|scenario.*only/i);
  });

  test("contract includes exact canonical TypeScript usage block", () => {
    const content = readFileSync(CONTRACT, "utf-8");
    const canonical = [
      'import { mkdtempSync } from "fs";',
      'import { join } from "path";',
      'import { tmpdir } from "os";',
      "",
      'const tmpDir = mkdtempSync(join(tmpdir(), "my-test-"));',
      'const ledger = join(tmpDir, "recorded-calls.jsonl");',
      "",
      "const result = Bun.spawnSync({",
      '  cmd: ["gh", "issue", "view", "42", "--json", "number,title"],',
      "  env: {",
      "    ...process.env,",
      "    STUB_GH_LEDGER: ledger,",
      '    STUB_GH_SCENARIO: "/path/to/scenario.json",',
      "  },",
      "});",
    ].join("\n");
    expect(content).toContain(canonical);
  });

  test("at least one scenario file exists", () => {
    expect(existsSync(SMOKE_SCENARIO)).toBe(true);
    const scenarios = JSON.parse(readFileSync(SMOKE_SCENARIO, "utf-8"));
    expect(Array.isArray(scenarios)).toBe(true);
    expect(scenarios.length).toBeGreaterThan(0);
  });

  test("stub-gh returns matched scenario response", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "stub-gh-match-"));
    const ledger = join(tmpDir, "recorded-calls.jsonl");

    const result = Bun.spawnSync({
      cmd: [STUB_GH, "issue", "view", "42", "--json", "number,title,body"],
      env: {
        ...process.env,
        STUB_GH_LEDGER: ledger,
        STUB_GH_SCENARIO: SMOKE_SCENARIO,
      },
    });

    expect(result.exitCode).toBe(0);
    const stdout = result.stdout.toString().trim();
    const parsed = JSON.parse(stdout);
    expect(parsed.number).toBe(42);
    expect(parsed.title).toContain("Widget Redesign");

    // Verify ledger entry was written
    expect(existsSync(ledger)).toBe(true);
    const entry = JSON.parse(readFileSync(ledger, "utf-8").trim().split("\n")[0]);
    expect(entry.bin).toBe("gh");
    expect(entry.argv).toContain("issue");
    expect(entry.argv).toContain("view");
    expect(entry.response_code).toBe(0);
    expect(entry.ts).toBeTruthy();
    expect(entry.scenario).toBe(SMOKE_SCENARIO);
  });

  test("stub-gh fails closed when STUB_GH_LEDGER is unset", () => {
    function walkFiles(dir: string, prefix = ""): string[] {
      const entries = readdirSync(dir, { withFileTypes: true });
      const files: string[] = [];
      for (const e of entries) {
        const rel = prefix ? `${prefix}/${e.name}` : e.name;
        if (e.isDirectory()) files.push(...walkFiles(join(dir, e.name), rel));
        else if (e.isFile()) files.push(rel);
      }
      return files;
    }

    const filesBefore = walkFiles(FIXTURES).sort();
    const contentsBefore = new Map(filesBefore.map(f => [f, readFileSync(join(FIXTURES, f))]));

    const result = Bun.spawnSync({
      cmd: [STUB_GH, "issue", "view", "42"],
      env: {
        ...process.env,
        STUB_GH_LEDGER: undefined,
        STUB_GH_SCENARIO: SMOKE_SCENARIO,
      },
    });

    expect(result.exitCode).toBe(2);
    const stderr = result.stderr.toString();
    expect(stderr).toContain("STUB_GH_LEDGER unset");
    expect(stderr).toContain("refusing to write to a default path");

    // Fixture directory unchanged: same files with same contents (recursive)
    const filesAfter = walkFiles(FIXTURES).sort();
    expect(filesAfter).toEqual(filesBefore);
    for (const f of filesAfter) {
      expect(readFileSync(join(FIXTURES, f))).toEqual(contentsBefore.get(f));
    }
  });

  test("stub-gh parallel invocations produce isolated ledgers (R14)", async () => {
    const tmpDir1 = mkdtempSync(join(tmpdir(), "stub-parallel-1-"));
    const tmpDir2 = mkdtempSync(join(tmpdir(), "stub-parallel-2-"));
    const ledger1 = join(tmpDir1, "recorded-calls.jsonl");
    const ledger2 = join(tmpDir2, "recorded-calls.jsonl");

    const env1 = {
      ...process.env,
      STUB_GH_LEDGER: ledger1,
      STUB_GH_SCENARIO: SMOKE_SCENARIO,
    };
    const env2 = {
      ...process.env,
      STUB_GH_LEDGER: ledger2,
      STUB_GH_SCENARIO: SMOKE_SCENARIO,
    };

    const p1 = Bun.spawn({ cmd: [STUB_GH, "issue", "create", "--title", "test1"], env: env1, stdout: "pipe", stderr: "pipe" });
    const p2 = Bun.spawn({ cmd: [STUB_GH, "label", "list"], env: env2, stdout: "pipe", stderr: "pipe" });

    const [exit1, exit2] = await Promise.all([p1.exited, p2.exited]);

    expect(exit1).toBe(0);
    expect(exit2).toBe(0);

    const entries1 = readFileSync(ledger1, "utf-8").trim().split("\n").map(l => JSON.parse(l));
    const entries2 = readFileSync(ledger2, "utf-8").trim().split("\n").map(l => JSON.parse(l));

    expect(entries1).toHaveLength(1);
    expect(entries2).toHaveLength(1);
    expect(entries1[0].argv).toContain("create");
    expect(entries2[0].argv).toContain("label");
  });

  test("stub-glab respects STUB_GLAB_LEDGER", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "stub-glab-"));
    const ledger = join(tmpDir, "recorded-calls.jsonl");

    // stub-glab should fail closed when no scenario
    const result = Bun.spawnSync({
      cmd: [STUB_GLAB, "issue", "view", "1"],
      env: {
        ...process.env,
        STUB_GLAB_LEDGER: ledger,
        STUB_GLAB_SCENARIO: "",
      },
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("no scenario file");
  });
});
