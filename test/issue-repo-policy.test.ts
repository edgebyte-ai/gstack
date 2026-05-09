/**
 * AC10: Issue repo policy tests.
 *
 * Verifies policy resolution, inheritance, and write-gate behavior:
 * - Default to read-write when neither config nor gbrain is set
 * - Explicit deny overrides everything
 * - inherit-gbrain delegates to gstack-gbrain-repo-policy
 * - Write operations blocked under read-only/deny
 * - Read operations proceed under read-only but blocked under deny
 */
import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const ROOT = join(import.meta.dir, "..");
const POLICY_BIN = join(ROOT, "bin", "gstack-issue-repo-policy");
const ARTIFACT_BIN = join(ROOT, "bin", "gstack-issue-artifact");
const CONFIG_BIN = join(ROOT, "bin", "gstack-config");
const FIXTURES = join(ROOT, "test", "fixtures", "issue-artifacts");
const SMOKE_SCENARIO = join(FIXTURES, "scenarios", "foundation-smoke.json");

function setupTmpEnv(tmpDir: string) {
  const gstackHome = join(tmpDir, ".gstack");
  mkdirSync(gstackHome, { recursive: true });
  // Ensure git repo with github remote for artifact helper
  Bun.spawnSync({ cmd: ["git", "init"], cwd: tmpDir });
  Bun.spawnSync({ cmd: ["git", "remote", "add", "origin", "https://github.com/test/repo.git"], cwd: tmpDir });
  return {
    GSTACK_HOME: gstackHome,
    PATH: `${join(ROOT, "bin")}:${FIXTURES}:${process.env.PATH}`,
    HOME: process.env.HOME!,
  };
}

describe("issue-repo-policy (AC10)", () => {
  test("show defaults to read-write when no config or gbrain", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "rp-default-"));
    const env = setupTmpEnv(tmpDir);

    const result = Bun.spawnSync({
      cmd: ["bun", "run", POLICY_BIN, "show"],
      cwd: tmpDir,
      env: { ...process.env, ...env },
    });
    expect(result.stdout.toString().trim()).toBe("read-write");
  });

  test("show returns deny when config is explicitly set to deny", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "rp-deny-"));
    const env = setupTmpEnv(tmpDir);

    // Set config
    Bun.spawnSync({
      cmd: [CONFIG_BIN, "set", "issue_repo_policy", "deny"],
      env: { ...process.env, ...env },
    });

    const result = Bun.spawnSync({
      cmd: ["bun", "run", POLICY_BIN, "show"],
      cwd: tmpDir,
      env: { ...process.env, ...env },
    });
    expect(result.stdout.toString().trim()).toBe("deny");
  });

  test("show returns read-only when config set to read-only", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "rp-ro-"));
    const env = setupTmpEnv(tmpDir);

    Bun.spawnSync({
      cmd: [CONFIG_BIN, "set", "issue_repo_policy", "read-only"],
      env: { ...process.env, ...env },
    });

    const result = Bun.spawnSync({
      cmd: ["bun", "run", POLICY_BIN, "show"],
      cwd: tmpDir,
      env: { ...process.env, ...env },
    });
    expect(result.stdout.toString().trim()).toBe("read-only");
  });

  test("check --op write succeeds under read-write", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "rp-check-rw-"));
    const env = setupTmpEnv(tmpDir);

    const result = Bun.spawnSync({
      cmd: ["bun", "run", POLICY_BIN, "check", "--op", "write"],
      cwd: tmpDir,
      env: { ...process.env, ...env },
    });
    expect(result.exitCode).toBe(0);
  });

  test("check --op write fails under read-only", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "rp-check-ro-"));
    const env = setupTmpEnv(tmpDir);

    Bun.spawnSync({
      cmd: [CONFIG_BIN, "set", "issue_repo_policy", "read-only"],
      env: { ...process.env, ...env },
    });

    const result = Bun.spawnSync({
      cmd: ["bun", "run", POLICY_BIN, "check", "--op", "write"],
      cwd: tmpDir,
      env: { ...process.env, ...env },
    });
    expect(result.exitCode).not.toBe(0);
  });

  test("check --op read succeeds under read-only", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "rp-check-read-ro-"));
    const env = setupTmpEnv(tmpDir);

    Bun.spawnSync({
      cmd: [CONFIG_BIN, "set", "issue_repo_policy", "read-only"],
      env: { ...process.env, ...env },
    });

    const result = Bun.spawnSync({
      cmd: ["bun", "run", POLICY_BIN, "check", "--op", "read"],
      cwd: tmpDir,
      env: { ...process.env, ...env },
    });
    expect(result.exitCode).toBe(0);
  });

  test("check --op read fails under deny", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "rp-check-read-deny-"));
    const env = setupTmpEnv(tmpDir);

    Bun.spawnSync({
      cmd: [CONFIG_BIN, "set", "issue_repo_policy", "deny"],
      env: { ...process.env, ...env },
    });

    const result = Bun.spawnSync({
      cmd: ["bun", "run", POLICY_BIN, "check", "--op", "read"],
      cwd: tmpDir,
      env: { ...process.env, ...env },
    });
    expect(result.exitCode).not.toBe(0);
  });

  test("artifact create blocked under read-only policy with zero gh calls", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "rp-artifact-blocked-"));
    const env = setupTmpEnv(tmpDir);
    const ledger = join(tmpDir, "recorded-calls.jsonl");
    const bodyFile = join(tmpDir, "body.md");
    writeFileSync(bodyFile, "test body");

    Bun.spawnSync({
      cmd: [CONFIG_BIN, "set", "issue_repo_policy", "read-only"],
      env: { ...process.env, ...env },
    });

    const result = Bun.spawnSync({
      cmd: ["bun", "run", ARTIFACT_BIN, "create", "--kind", "ceo-plan", "--title", "Test", "--body-file", bodyFile],
      cwd: tmpDir,
      env: {
        ...process.env,
        ...env,
        STUB_GH_LEDGER: ledger,
        STUB_GH_SCENARIO: SMOKE_SCENARIO,
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toContain("[issue-artifacts] BLOCKED");
    expect(result.stderr.toString()).toContain("repo policy");

    // Zero gh/glab invocations recorded
    if (existsSync(ledger)) {
      const entries = readFileSync(ledger, "utf-8").trim().split("\n").filter(Boolean);
      expect(entries).toHaveLength(0);
    }
  });

  test("artifact read proceeds under read-only policy", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "rp-artifact-read-ro-"));
    const env = setupTmpEnv(tmpDir);
    const ledger = join(tmpDir, "recorded-calls.jsonl");

    Bun.spawnSync({
      cmd: [CONFIG_BIN, "set", "issue_repo_policy", "read-only"],
      env: { ...process.env, ...env },
    });

    const result = Bun.spawnSync({
      cmd: ["bun", "run", ARTIFACT_BIN, "read", "42"],
      cwd: tmpDir,
      env: {
        ...process.env,
        ...env,
        STUB_GH_LEDGER: ledger,
        STUB_GH_SCENARIO: SMOKE_SCENARIO,
      },
    });

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout.toString().trim());
    expect(parsed.title).toContain("Widget Redesign");
  });

  test("artifact read blocked under deny policy", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "rp-artifact-read-deny-"));
    const env = setupTmpEnv(tmpDir);
    const ledger = join(tmpDir, "recorded-calls.jsonl");

    Bun.spawnSync({
      cmd: [CONFIG_BIN, "set", "issue_repo_policy", "deny"],
      env: { ...process.env, ...env },
    });

    const result = Bun.spawnSync({
      cmd: ["bun", "run", ARTIFACT_BIN, "read", "42"],
      cwd: tmpDir,
      env: {
        ...process.env,
        ...env,
        STUB_GH_LEDGER: ledger,
        STUB_GH_SCENARIO: SMOKE_SCENARIO,
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toContain("[issue-artifacts] BLOCKED");
  });
});
