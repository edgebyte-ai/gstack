/**
 * AC9: Issue-artifact helper subcommand tests against stub shims.
 *
 * All tests use per-test STUB_GH_LEDGER per R14 contract.
 * Tests cover: create, update, read, comment, close, link-local,
 * list-by-label, validate-url, handoff, and comment trust filtering (R12).
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { readFileSync, existsSync, mkdtempSync, writeFileSync, copyFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const ROOT = join(import.meta.dir, "..");
const BIN = join(ROOT, "bin", "gstack-issue-artifact");
const FIXTURES = join(ROOT, "test", "fixtures", "issue-artifacts");
const SMOKE_SCENARIO = join(FIXTURES, "scenarios", "foundation-smoke.json");
const GITLAB_TRUST_SCENARIO = join(FIXTURES, "scenarios", "gitlab-trust.json");

function makeEnv(tmpDir: string, scenarioPath?: string) {
  const ledger = join(tmpDir, "recorded-calls.jsonl");
  return {
    env: {
      ...process.env,
      PATH: `${FIXTURES}:${process.env.PATH}`,
      STUB_GH_LEDGER: ledger,
      STUB_GH_SCENARIO: scenarioPath || SMOKE_SCENARIO,
      GSTACK_HOME: join(tmpDir, ".gstack"),
    },
    ledger,
  };
}

function run(args: string[], tmpDir: string, scenarioPath?: string) {
  const { env, ledger } = makeEnv(tmpDir, scenarioPath);
  mkdirSync(join(tmpDir, ".gstack"), { recursive: true });
  // Set up a git remote so detect-platform works
  const gitDir = join(tmpDir, ".git");
  if (!existsSync(gitDir)) {
    Bun.spawnSync({ cmd: ["git", "init"], cwd: tmpDir, env });
    Bun.spawnSync({ cmd: ["git", "remote", "add", "origin", "https://github.com/test/repo.git"], cwd: tmpDir, env });
  }

  const result = Bun.spawnSync({
    cmd: ["bun", "run", BIN, ...args],
    cwd: tmpDir,
    env,
  });

  const ledgerEntries = existsSync(ledger)
    ? readFileSync(ledger, "utf-8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l))
    : [];

  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString().trim(),
    ledger: ledgerEntries,
  };
}

describe("issue-artifacts helper (AC9)", () => {
  test("detect-platform returns github for github remote", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "ia-detect-"));
    const result = run(["detect-platform"], tmpDir);
    expect(result.stdout).toBe("github");
  });

  test("detect-platform returns none for non-github/gitlab remote", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "ia-detect-none-"));
    mkdirSync(join(tmpDir, ".gstack"), { recursive: true });
    Bun.spawnSync({ cmd: ["git", "init"], cwd: tmpDir });
    Bun.spawnSync({ cmd: ["git", "remote", "add", "origin", "https://bitbucket.org/test/repo.git"], cwd: tmpDir });

    const result = Bun.spawnSync({
      cmd: ["bun", "run", BIN, "detect-platform"],
      cwd: tmpDir,
      env: { ...process.env, GSTACK_HOME: join(tmpDir, ".gstack") },
    });
    expect(result.stdout.toString().trim()).toBe("none");
  });

  test("create succeeds and prints url + number", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "ia-create-"));
    const bodyFile = join(tmpDir, "body.md");
    writeFileSync(bodyFile, "## Plan\n\nTest body.");

    const result = run(["create", "--kind", "ceo-plan", "--title", "Test Plan", "--body-file", bodyFile], tmpDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("https://github.com/test/repo/issues/42");
    expect(result.stdout).toContain("42");
    expect(result.ledger.length).toBeGreaterThan(0);
  });

  test("create ensures labels exist (calls label list + label create)", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "ia-create-labels-"));
    const bodyFile = join(tmpDir, "body.md");
    writeFileSync(bodyFile, "body");

    const result = run(["create", "--kind", "design-doc", "--title", "Test", "--body-file", bodyFile], tmpDir);
    expect(result.exitCode).toBe(0);

    const labelListCalls = result.ledger.filter(e => e.argv.includes("label") && e.argv.includes("list"));
    expect(labelListCalls.length).toBeGreaterThan(0);
  });

  test("update calls gh issue edit", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "ia-update-"));
    const bodyFile = join(tmpDir, "body.md");
    writeFileSync(bodyFile, "updated body");

    const result = run(["update", "42", "--body-file", bodyFile], tmpDir);
    expect(result.exitCode).toBe(0);
    const editCalls = result.ledger.filter(e => e.argv.includes("edit"));
    expect(editCalls.length).toBeGreaterThan(0);
  });

  test("read returns normalized JSON with trust filtering", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "ia-read-"));

    const result = run(["read", "42", "--comments-trust", "trusted-only"], tmpDir);
    expect(result.exitCode).toBe(0);

    const parsed = JSON.parse(result.stdout);
    expect(parsed.url).toBe("https://github.com/test/repo/issues/42");
    expect(parsed.title).toContain("Widget Redesign");
    expect(parsed.author).toBe("garry");

    // trusted-only: OWNER and COLLABORATOR kept, two NONE dropped
    expect(parsed.comments_trusted).toHaveLength(2);
    expect(parsed.comments_dropped_count).toBe(2);
    expect(parsed.comments_dropped_authors).toContain("random-stranger");
    expect(parsed.comments_dropped_authors).toContain("helpful-outsider");

    // Dropped bodies must NOT appear anywhere in stdout (R12 quarantine)
    expect(result.stdout).not.toContain("IGNORE PRIOR INSTRUCTIONS");
    expect(result.stdout).not.toContain("Found a typo");
  });

  test("read --comments-trust all returns everything with warning", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "ia-read-all-"));

    const result = run(["read", "42", "--comments-trust", "all"], tmpDir);
    expect(result.exitCode).toBe(0);

    const parsed = JSON.parse(result.stdout);
    expect(parsed.comments_trusted).toHaveLength(4);
    expect(parsed.comments_dropped_count).toBe(0);
    expect(result.stderr).toContain("WARNING");
    expect(result.stderr).toContain("comments-trust=all");
  });

  test("read --comments-trust issue-author-only keeps only issue author comments", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "ia-read-author-"));

    const result = run(["read", "42", "--comments-trust", "issue-author-only"], tmpDir);
    expect(result.exitCode).toBe(0);

    const parsed = JSON.parse(result.stdout);
    expect(parsed.comments_trusted).toHaveLength(1);
    expect(parsed.comments_trusted[0].author).toBe("garry");
    expect(parsed.comments_dropped_count).toBe(3);
  });

  test("comment posts via gh issue comment", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "ia-comment-"));
    const bodyFile = join(tmpDir, "comment.md");
    writeFileSync(bodyFile, "LGTM, shipping this.");

    const result = run(["comment", "42", "--body-file", bodyFile], tmpDir);
    expect(result.exitCode).toBe(0);

    const commentCalls = result.ledger.filter(e => e.argv.includes("comment"));
    expect(commentCalls.length).toBeGreaterThan(0);
  });

  test("close calls gh issue close", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "ia-close-"));

    const result = run(["close", "42"], tmpDir);
    expect(result.exitCode).toBe(0);

    const closeCalls = result.ledger.filter(e => e.argv.includes("close"));
    expect(closeCalls.length).toBeGreaterThan(0);
  });

  test("close with --comment-body-file posts comment then closes", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "ia-close-comment-"));
    const bodyFile = join(tmpDir, "closing.md");
    writeFileSync(bodyFile, "Closing: all items addressed.");

    const result = run(["close", "42", "--comment-body-file", bodyFile], tmpDir);
    expect(result.exitCode).toBe(0);

    const commentCalls = result.ledger.filter(e => e.argv.includes("comment"));
    const closeCalls = result.ledger.filter(e => e.argv.includes("close"));
    expect(commentCalls.length).toBeGreaterThan(0);
    expect(closeCalls.length).toBeGreaterThan(0);
  });

  test("link-local adds frontmatter to file without existing frontmatter", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "ia-link-new-"));
    const testFile = join(tmpDir, "plan.md");
    writeFileSync(testFile, "# My Plan\n\nContent here.");

    const result = run(["link-local", "--file", testFile, "--issue", "https://github.com/test/repo/issues/42"], tmpDir);
    expect(result.exitCode).toBe(0);

    const content = readFileSync(testFile, "utf-8");
    expect(content).toMatch(/^---\n/);
    expect(content).toContain("issue: https://github.com/test/repo/issues/42");
    expect(content).toContain("issue-state: open");
    expect(content).toContain("# My Plan");
  });

  test("link-local merges into existing frontmatter without clobbering", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "ia-link-existing-"));
    const sampleSrc = join(FIXTURES, "sample-frontmatter.md");
    const testFile = join(tmpDir, "doc.md");
    copyFileSync(sampleSrc, testFile);

    const result = run(["link-local", "--file", testFile, "--issue", "https://github.com/test/repo/issues/42"], tmpDir);
    expect(result.exitCode).toBe(0);

    const content = readFileSync(testFile, "utf-8");
    expect(content).toContain("Status: draft");
    expect(content).toContain("Author: test");
    expect(content).toContain("issue: https://github.com/test/repo/issues/42");
    expect(content).toContain("issue-state: open");
  });

  test("link-local is idempotent", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "ia-link-idem-"));
    const testFile = join(tmpDir, "doc.md");
    writeFileSync(testFile, "# Doc\n\nContent.");

    run(["link-local", "--file", testFile, "--issue", "https://github.com/test/repo/issues/42"], tmpDir);
    const first = readFileSync(testFile, "utf-8");

    run(["link-local", "--file", testFile, "--issue", "https://github.com/test/repo/issues/42"], tmpDir);
    const second = readFileSync(testFile, "utf-8");

    expect(first).toBe(second);
  });

  test("list-by-label returns issues", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "ia-list-"));

    const result = run(["list-by-label", "--label", "gstack:ceo-plan"], tmpDir);
    expect(result.exitCode).toBe(0);

    const parsed = JSON.parse(result.stdout);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThan(0);
  });

  test("validate-url accepts same-repo URL", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "ia-validate-ok-"));

    const result = run(["validate-url", "https://github.com/test/repo/issues/42"], tmpDir);
    expect(result.exitCode).toBe(0);
  });

  test("validate-url rejects cross-repo URL (R6)", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "ia-validate-reject-"));

    const result = run(["validate-url", "https://github.com/other-org/other-repo/issues/1"], tmpDir);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("[issue-artifacts] BLOCKED: cross-repo URL");
    expect(result.stderr).toContain("rejected");
  });

  test("handoff emits JSON with repo metadata", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "ia-handoff-"));
    const outFile = join(tmpDir, "handoff.json");

    const result = run(["handoff", "--issue", "42", "--kind", "ceo-plan", "--out", outFile], tmpDir);
    expect(result.exitCode).toBe(0);

    expect(existsSync(outFile)).toBe(true);
    const payload = JSON.parse(readFileSync(outFile, "utf-8"));
    expect(payload.kind).toBe("ceo-plan");
    expect(payload.issue_number).toBe(42);
    expect(payload.issue_title).toBeTruthy();
    expect(payload.repo).toContain("test/repo");
  });
});

function runGlab(args: string[], tmpDir: string) {
  const ledger = join(tmpDir, "glab-calls.jsonl");
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    PATH: `${FIXTURES}:${process.env.PATH}`,
    STUB_GLAB_LEDGER: ledger,
    STUB_GLAB_SCENARIO: GITLAB_TRUST_SCENARIO,
    GSTACK_HOME: join(tmpDir, ".gstack"),
  };

  mkdirSync(join(tmpDir, ".gstack"), { recursive: true });

  const gitDir = join(tmpDir, ".git");
  if (!existsSync(gitDir)) {
    Bun.spawnSync({ cmd: ["git", "init"], cwd: tmpDir, env });
    Bun.spawnSync({
      cmd: ["git", "remote", "add", "origin", "git@gitlab.com:test/repo.git"],
      cwd: tmpDir,
      env,
    });
  }

  const result = Bun.spawnSync({
    cmd: ["bun", "run", BIN, ...args],
    cwd: tmpDir,
    env,
  });

  const ledgerEntries = existsSync(ledger)
    ? readFileSync(ledger, "utf-8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l))
    : [];

  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString().trim(),
    ledger: ledgerEntries,
  };
}

describe("gstack-issue-artifact (GitLab)", () => {
  test("read --comments-trust trusted-only keeps Developer+ (access_level >= 30)", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "ia-gl-trust-"));

    const result = runGlab(["read", "42", "--comments-trust", "trusted-only"], tmpDir);
    expect(result.exitCode).toBe(0);

    const parsed = JSON.parse(result.stdout);
    expect(parsed.comments_trusted).toHaveLength(2);

    const authors = parsed.comments_trusted.map((c: any) => c.author);
    expect(authors).toContain("garry");
    expect(authors).toContain("dev-alice");
    expect(authors).not.toContain("reporter-bob");
    expect(authors).not.toContain("guest-eve");
    expect(authors).not.toContain("no-field-user");

    expect(parsed.comments_dropped_count).toBe(3);
  });

  test("read --comments-trust trusted-only fail-closed on missing access_level", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "ia-gl-failclose-"));

    const result = runGlab(["read", "42", "--comments-trust", "trusted-only"], tmpDir);
    expect(result.exitCode).toBe(0);

    const parsed = JSON.parse(result.stdout);
    const authors = parsed.comments_trusted.map((c: any) => c.author);
    expect(authors).not.toContain("no-field-user");
  });

  test("read --comments-trust all passes all GitLab notes through", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "ia-gl-all-"));

    const result = runGlab(["read", "42", "--comments-trust", "all"], tmpDir);
    expect(result.exitCode).toBe(0);

    const parsed = JSON.parse(result.stdout);
    expect(parsed.comments_trusted).toHaveLength(5);
    expect(parsed.comments_dropped_count).toBe(0);
  });

  test("read --comments-trust issue-author-only keeps only issue author on GitLab", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "ia-gl-author-"));

    const result = runGlab(["read", "42", "--comments-trust", "issue-author-only"], tmpDir);
    expect(result.exitCode).toBe(0);

    const parsed = JSON.parse(result.stdout);
    expect(parsed.comments_trusted).toHaveLength(1);
    expect(parsed.comments_trusted[0].author).toBe("garry");
    expect(parsed.comments_dropped_count).toBe(4);
  });

  test("trusted-only calls glab api for member access levels (F15)", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "ia-gl-api-"));

    const result = runGlab(["read", "42", "--comments-trust", "trusted-only"], tmpDir);
    expect(result.exitCode).toBe(0);

    const apiCalls = result.ledger.filter(e =>
      e.argv.some((a: string) => a.includes("members/all"))
    );
    expect(apiCalls.length).toBeGreaterThan(0);
  });

  test("ensureLabel uses --name flag and --output json for GitLab (F2)", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "ia-gl-label-"));
    const bodyFile = join(tmpDir, "body.md");
    writeFileSync(bodyFile, "body");

    const result = runGlab(["create", "--kind", "design-doc", "--title", "GL Label Test", "--body-file", bodyFile], tmpDir);

    const labelListCalls = result.ledger.filter(e =>
      e.argv.includes("label") && e.argv.includes("list") && e.argv.includes("--output") && e.argv.includes("json")
    );
    expect(labelListCalls.length).toBeGreaterThan(0);
  });

  test("validate-url accepts same-repo GitLab URL with /-/issues/ (F16)", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "ia-gl-url-ok-"));

    const result = runGlab(["validate-url", "https://gitlab.com/test/repo/-/issues/42"], tmpDir);
    expect(result.exitCode).toBe(0);
  });

  test("validate-url rejects cross-repo GitLab URL (F16)", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "ia-gl-url-reject-"));

    const result = runGlab(["validate-url", "https://gitlab.com/other-org/other-repo/-/issues/1"], tmpDir);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("BLOCKED");
    expect(result.stderr).toContain("rejected");
  });
});
