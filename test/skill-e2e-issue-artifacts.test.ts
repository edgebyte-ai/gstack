/**
 * AC4 — End-to-end issue-artifacts integration test.
 *
 * Exercises the full resolver → bash-block → stub-shim pipeline for at least
 * one producer skill. Tests two contracts:
 *
 *   1. Frontmatter stamping: the happy path calls create then link-local with
 *      the correct --file and --issue args, and both invocations appear in the
 *      STUB_GH_LEDGER with argument-level detail.
 *
 *   2. Helper failure non-blocking: when create or link-local exit non-zero,
 *      the bash block still exits 0 (FALLBACK path) and does NOT abort the
 *      parent skill. The ledger records the failed invocation.
 *
 * Uses the stub shim contract from STUB-CONTRACT.md: per-test STUB_GH_LEDGER
 * isolation via mkdtempSync, custom stub binaries for gstack-config,
 * gstack-issue-artifact, and gstack-issue-repo-policy.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { generateIssueArtifactsBlock } from '../scripts/resolvers/issue-artifacts';
import type { TemplateContext, HostPaths } from '../scripts/resolvers/types';
import { marked } from 'marked';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, chmodSync, rmSync, copyFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { runSkillTest } from './helpers/session-runner';
import {
  ROOT, runId, evalsEnabled,
  describeIfSelected, testConcurrentIfSelected,
  logCost, recordE2E,
  createEvalCollector, finalizeEvalCollector,
} from './helpers/e2e-helpers';

const evalCollector = createEvalCollector('e2e-issue-artifacts');

const MOCK_PATHS: HostPaths = {
  skillRoot: '~/.claude/skills/gstack',
  localSkillRoot: '.claude/skills',
  binDir: '~/.claude/skills/gstack/bin',
  browseDir: '~/.claude/skills/gstack/browse/dist',
  designDir: '~/.claude/skills/gstack/design/dist',
  makePdfDir: '~/.claude/skills/gstack/make-pdf/dist',
};

function makeCtx(skillName: string, binDir: string): TemplateContext {
  return {
    skillName,
    tmplPath: `${skillName}/SKILL.md.tmpl`,
    host: 'claude' as any,
    paths: { ...MOCK_PATHS, binDir },
  };
}

function extractBashBlock(output: string): string | null {
  const tokens = marked.lexer(output);
  let inside = false;
  for (const token of tokens) {
    if (token.type === 'html' && token.text.includes('<!-- @issue-artifacts:begin -->')) {
      inside = true;
      continue;
    }
    if (inside && token.type === 'code') {
      return token.text;
    }
    if (inside && token.type === 'html' && token.text.includes('<!-- @issue-artifacts:end -->')) {
      break;
    }
  }
  return null;
}

interface LedgerEntry {
  ts: string;
  bin: string;
  argv: string[];
  response_code: number;
}

function readLedger(ledgerPath: string): LedgerEntry[] {
  if (!existsSync(ledgerPath)) return [];
  return readFileSync(ledgerPath, 'utf-8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

const LEDGER_FN = `
_ledger() {
  [[ -z "\${STUB_GH_LEDGER:-}" ]] && return 0
  local _ec="$1"; shift
  local _argv
  _argv=$(printf '%s\\n' "$@" | jq -R . 2>/dev/null | jq -sc . 2>/dev/null || echo '[]')
  printf '{"ts":"%s","bin":"%s","argv":%s,"response_code":%d}\\n' \\
    "$(date -u +'%Y-%m-%dT%H:%M:%S.000Z')" "$_BIN" "$_argv" "$_ec" >> "$STUB_GH_LEDGER"
}`.trim();

function makeBinDir(tmpDir: string): string {
  const binDir = join(tmpDir, 'bin');
  mkdirSync(binDir, { recursive: true });
  return binDir;
}

function writeConfigStub(binDir: string, configMap: Record<string, string>) {
  const cases = Object.entries(configMap)
    .map(([k, v]) => `  ${k}) _OUT="${v}"; _EC=0 ;;`)
    .join('\n');
  const script = `#!/usr/bin/env bash
set -euo pipefail
_BIN="gstack-config"
${LEDGER_FN}
_OUT="unknown"; _EC=0
case "\$2" in
${cases}
  *) _OUT="unknown"; _EC=0 ;;
esac
_ledger "$_EC" "$@"
echo "$_OUT"
exit "$_EC"
`;
  const p = join(binDir, 'gstack-config');
  writeFileSync(p, script);
  chmodSync(p, 0o755);
}

function writeArtifactStub(
  binDir: string,
  opts: {
    'detect-platform': { stdout: string; exit: number };
    create: { stdout: string; stderr?: string; exit: number };
    'link-local': { stdout: string; stderr?: string; exit: number };
  },
) {
  const dp = opts['detect-platform'];
  const cr = opts.create;
  const ll = opts['link-local'];
  // When link-local succeeds, the stub mutates the artifact file to stamp
  // `issue:` and `issue-state: open` into its YAML frontmatter, mirroring
  // what the real bin/gstack-issue-artifact does. This lets AC4 assertions
  // re-read the file and verify the stamp end-to-end.
  const linkLocalBody = ll.exit === 0
    ? `
    _FILE=""; _ISSUE=""
    shift
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --file)  _FILE="$2"; shift 2 ;;
        --issue) _ISSUE="$2"; shift 2 ;;
        *) shift ;;
      esac
    done
    if [[ -n "$_FILE" && -f "$_FILE" && -n "$_ISSUE" ]]; then
      _CONTENT=$(cat "$_FILE")
      if [[ "$_CONTENT" == ---* ]]; then
        _END=$(echo "$_CONTENT" | tail -n +2 | grep -n '^---$' | head -1 | cut -d: -f1)
        _END=$((_END + 1))
        _HEAD=$(echo "$_CONTENT" | head -n "$_END" | grep -v '^issue:' | grep -v '^issue-state:')
        _TAIL=$(echo "$_CONTENT" | tail -n +"$((_END + 1))")
        _FM_BODY=$(echo "$_HEAD" | tail -n +2 | head -n "$((_END - 2))")
        printf '%s\\n' "---" > "$_FILE"
        [[ -n "$_FM_BODY" ]] && printf '%s\\n' "$_FM_BODY" >> "$_FILE"
        printf 'issue: %s\\n' "$_ISSUE" >> "$_FILE"
        printf 'issue-state: open\\n' >> "$_FILE"
        printf '%s\\n' "---" >> "$_FILE"
        [[ -n "$_TAIL" ]] && printf '%s\\n' "$_TAIL" >> "$_FILE"
      fi
    fi
    echo "${ll.stdout}"
    exit 0`
    : `
    ${ll.stderr ? `echo "${ll.stderr}" >&2` : ':'}
    echo "${ll.stdout}"
    exit ${ll.exit}`;

  const script = `#!/usr/bin/env bash
set -uo pipefail
_BIN="gstack-issue-artifact"
${LEDGER_FN}
case "\$1" in
  detect-platform)
    _ledger ${dp.exit} "$@"
    echo "${dp.stdout}"
    exit ${dp.exit}
    ;;
  create)
    _ledger ${cr.exit} "$@"
    ${cr.stderr ? `echo "${cr.stderr}" >&2` : ':'}
    echo "${cr.stdout}"
    exit ${cr.exit}
    ;;
  link-local)
    _ledger ${ll.exit} "$@"
    ${linkLocalBody}
    ;;
  *) _ledger 1 "$@"; echo "unknown: \$1" >&2; exit 1 ;;
esac
`;
  const p = join(binDir, 'gstack-issue-artifact');
  writeFileSync(p, script);
  chmodSync(p, 0o755);
}

function writePolicyStub(binDir: string, opts: { stdout: string; exit: number }) {
  const script = `#!/usr/bin/env bash
set -uo pipefail
_BIN="gstack-issue-repo-policy"
${LEDGER_FN}
_ledger ${opts.exit} "$@"
echo "${opts.stdout}"
exit ${opts.exit}
`;
  const p = join(binDir, 'gstack-issue-repo-policy');
  writeFileSync(p, script);
  chmodSync(p, 0o755);
}

function runBlock(
  code: string,
  binDir: string,
  ledger: string,
  artifactPath: string,
  artifactTitle: string,
): { stdout: string; stderr: string; exitCode: number } {
  const result = Bun.spawnSync({
    cmd: ['bash', '-c', code],
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      ISSUE_ARTIFACT_PATH: artifactPath,
      ISSUE_ARTIFACT_TITLE: artifactTitle,
      STUB_GH_LEDGER: ledger,
    },
  });
  return {
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString().trim(),
    exitCode: result.exitCode,
  };
}

// ---------------------------------------------------------------------------
// 1. Frontmatter stamping — happy path E2E for office-hours
// ---------------------------------------------------------------------------

describe('AC4: frontmatter stamping E2E', () => {
  test('happy path: create + link-local both called with correct args', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'e2e-issue-artifacts-happy-'));
    try {
      const binDir = makeBinDir(tmpDir);
      const ledger = join(tmpDir, 'recorded-calls.jsonl');
      const artifactPath = join(tmpDir, 'design-doc.md');
      writeFileSync(artifactPath, '---\ntitle: Office Hours Output\n---\n\n# Design Doc\n');

      writeConfigStub(binDir, { issue_artifacts: 'on', issue_tracker: 'github' });
      writeArtifactStub(binDir, {
        'detect-platform': { stdout: 'github', exit: 0 },
        create: { stdout: 'https://github.com/test/repo/issues/42', exit: 0 },
        'link-local': { stdout: 'ok', exit: 0 },
      });
      writePolicyStub(binDir, { stdout: 'allowed', exit: 0 });

      const output = generateIssueArtifactsBlock(makeCtx('office-hours', binDir));
      const code = extractBashBlock(output);
      expect(code).not.toBeNull();

      const r = runBlock(code!, binDir, ledger, artifactPath, 'Office Hours: My Startup Idea');

      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('published gstack:design-doc');
      expect(r.stdout).toContain('https://github.com/test/repo/issues/42');

      const entries = readLedger(ledger);

      // create was called with --kind, --title, --body-file
      const createEntry = entries.find(e => e.bin === 'gstack-issue-artifact' && e.argv[0] === 'create');
      expect(createEntry).toBeDefined();
      expect(createEntry!.response_code).toBe(0);
      expect(createEntry!.argv).toContain('--kind');
      expect(createEntry!.argv).toContain('gstack:design-doc');
      expect(createEntry!.argv).toContain('--title');
      expect(createEntry!.argv).toContain('Office Hours: My Startup Idea');
      expect(createEntry!.argv).toContain('--body-file');
      expect(createEntry!.argv).toContain(artifactPath);

      // link-local was called with --file and --issue
      const linkEntry = entries.find(e => e.bin === 'gstack-issue-artifact' && e.argv[0] === 'link-local');
      expect(linkEntry).toBeDefined();
      expect(linkEntry!.response_code).toBe(0);
      expect(linkEntry!.argv).toContain('--file');
      expect(linkEntry!.argv).toContain(artifactPath);
      expect(linkEntry!.argv).toContain('--issue');
      expect(linkEntry!.argv).toContain('https://github.com/test/repo/issues/42');

      // AC4: re-read the local file and confirm frontmatter stamp
      const stamped = readFileSync(artifactPath, 'utf-8');
      expect(stamped).toMatch(/\nissue: https:\/\/github\.com\/test\/repo\/issues\/42\n/);
      expect(stamped).toMatch(/\nissue-state: open\n/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('happy path with extra labels (design-consultation)', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'e2e-issue-artifacts-labels-'));
    try {
      const binDir = makeBinDir(tmpDir);
      const ledger = join(tmpDir, 'recorded-calls.jsonl');
      const artifactPath = join(tmpDir, 'design-system.md');
      writeFileSync(artifactPath, '# Design System\n');

      writeConfigStub(binDir, { issue_artifacts: 'on', issue_tracker: 'github' });
      writeArtifactStub(binDir, {
        'detect-platform': { stdout: 'github', exit: 0 },
        create: { stdout: 'https://github.com/test/repo/issues/55', exit: 0 },
        'link-local': { stdout: 'ok', exit: 0 },
      });
      writePolicyStub(binDir, { stdout: 'allowed', exit: 0 });

      const output = generateIssueArtifactsBlock(makeCtx('design-consultation', binDir));
      const code = extractBashBlock(output);
      expect(code).not.toBeNull();

      const r = runBlock(code!, binDir, ledger, artifactPath, 'Design System for Acme');
      expect(r.exitCode).toBe(0);

      const entries = readLedger(ledger);
      const createEntry = entries.find(e => e.bin === 'gstack-issue-artifact' && e.argv[0] === 'create');
      expect(createEntry).toBeDefined();
      expect(createEntry!.argv).toContain('--label');
      expect(createEntry!.argv).toContain('design-system');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Helper failure non-blocking — create and link-local failures exit 0
// ---------------------------------------------------------------------------

describe('AC4: helper failure non-blocking', () => {
  test('create failure: exits 0 with FALLBACK message, no link-local call', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'e2e-issue-artifacts-create-fail-'));
    try {
      const binDir = makeBinDir(tmpDir);
      const ledger = join(tmpDir, 'recorded-calls.jsonl');
      const artifactPath = join(tmpDir, 'artifact.md');
      writeFileSync(artifactPath, '# Artifact\n');

      writeConfigStub(binDir, { issue_artifacts: 'on', issue_tracker: 'github' });
      writeArtifactStub(binDir, {
        'detect-platform': { stdout: 'github', exit: 0 },
        create: { stdout: '', stderr: 'HTTP 422 Unprocessable Entity', exit: 1 },
        'link-local': { stdout: 'ok', exit: 0 },
      });
      writePolicyStub(binDir, { stdout: 'allowed', exit: 0 });

      const output = generateIssueArtifactsBlock(makeCtx('plan-ceo-review', binDir));
      const code = extractBashBlock(output);
      expect(code).not.toBeNull();

      const r = runBlock(code!, binDir, ledger, artifactPath, 'CEO Review Plan');

      // Non-blocking: exits 0 despite create failure
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('FALLBACK');
      expect(r.stdout).not.toContain('published');

      const entries = readLedger(ledger);

      // create was attempted
      const createEntry = entries.find(e => e.bin === 'gstack-issue-artifact' && e.argv[0] === 'create');
      expect(createEntry).toBeDefined();
      expect(createEntry!.response_code).toBe(1);

      // link-local was NOT called (create failed first)
      const linkEntry = entries.find(e => e.bin === 'gstack-issue-artifact' && e.argv[0] === 'link-local');
      expect(linkEntry).toBeUndefined();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('link-local failure: exits 0 with FALLBACK, create was still called', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'e2e-issue-artifacts-link-fail-'));
    try {
      const binDir = makeBinDir(tmpDir);
      const ledger = join(tmpDir, 'recorded-calls.jsonl');
      const artifactPath = join(tmpDir, 'artifact.md');
      writeFileSync(artifactPath, '# Artifact\n');

      writeConfigStub(binDir, { issue_artifacts: 'on', issue_tracker: 'github' });
      writeArtifactStub(binDir, {
        'detect-platform': { stdout: 'github', exit: 0 },
        create: { stdout: 'https://github.com/test/repo/issues/77', exit: 0 },
        'link-local': { stdout: '', stderr: 'ENOENT: file moved', exit: 1 },
      });
      writePolicyStub(binDir, { stdout: 'allowed', exit: 0 });

      const output = generateIssueArtifactsBlock(makeCtx('retro', binDir));
      const code = extractBashBlock(output);
      expect(code).not.toBeNull();

      const r = runBlock(code!, binDir, ledger, artifactPath, 'Weekly Retro');

      // Non-blocking: exits 0 despite link-local failure
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('FALLBACK');
      expect(r.stdout).toContain('link-local failed');
      expect(r.stdout).not.toContain('published');

      const entries = readLedger(ledger);

      // create succeeded
      const createEntry = entries.find(e => e.bin === 'gstack-issue-artifact' && e.argv[0] === 'create');
      expect(createEntry).toBeDefined();
      expect(createEntry!.response_code).toBe(0);
      expect(createEntry!.argv).toContain('--kind');
      expect(createEntry!.argv).toContain('gstack:retro');

      // link-local was attempted and failed
      const linkEntry = entries.find(e => e.bin === 'gstack-issue-artifact' && e.argv[0] === 'link-local');
      expect(linkEntry).toBeDefined();
      expect(linkEntry!.response_code).toBe(1);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('policy blocked: exits 0, no create or link-local called', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'e2e-issue-artifacts-policy-'));
    try {
      const binDir = makeBinDir(tmpDir);
      const ledger = join(tmpDir, 'recorded-calls.jsonl');
      const artifactPath = join(tmpDir, 'artifact.md');
      writeFileSync(artifactPath, '# Artifact\n');

      writeConfigStub(binDir, { issue_artifacts: 'on', issue_tracker: 'github' });
      writeArtifactStub(binDir, {
        'detect-platform': { stdout: 'github', exit: 0 },
        create: { stdout: 'https://github.com/test/repo/issues/1', exit: 0 },
        'link-local': { stdout: 'ok', exit: 0 },
      });
      writePolicyStub(binDir, { stdout: 'write-denied', exit: 1 });

      const output = generateIssueArtifactsBlock(makeCtx('plan-eng-review', binDir));
      const code = extractBashBlock(output);
      expect(code).not.toBeNull();

      const r = runBlock(code!, binDir, ledger, artifactPath, 'Eng Plan');

      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('BLOCKED');
      expect(r.stdout).not.toContain('published');

      const entries = readLedger(ledger);

      // Policy was checked
      expect(entries.some(e => e.bin === 'gstack-issue-repo-policy')).toBe(true);

      // create was NOT called (blocked before reaching it)
      expect(entries.some(e => e.bin === 'gstack-issue-artifact' && e.argv[0] === 'create')).toBe(false);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('stderr bounded: multi-line policy error shows only first line', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'e2e-issue-artifacts-stderr-'));
    try {
      const binDir = makeBinDir(tmpDir);
      const ledger = join(tmpDir, 'recorded-calls.jsonl');
      const artifactPath = join(tmpDir, 'artifact.md');
      writeFileSync(artifactPath, '# Artifact\n');

      writeConfigStub(binDir, { issue_artifacts: 'on', issue_tracker: 'github' });
      writeArtifactStub(binDir, {
        'detect-platform': { stdout: 'github', exit: 0 },
        create: { stdout: '', exit: 0 },
        'link-local': { stdout: 'ok', exit: 0 },
      });

      // Policy stub that outputs multi-line error
      const multiLineScript = `#!/usr/bin/env bash
set -uo pipefail
_BIN="gstack-issue-repo-policy"
${LEDGER_FN}
_ledger 1 "$@"
echo "denied-first-line"
echo "stack-trace-line-2" >&2
echo "stack-trace-line-3" >&2
exit 1
`;
      const p = join(binDir, 'gstack-issue-repo-policy');
      writeFileSync(p, multiLineScript);
      chmodSync(p, 0o755);

      const output = generateIssueArtifactsBlock(makeCtx('office-hours', binDir));
      const code = extractBashBlock(output);
      expect(code).not.toBeNull();

      const r = runBlock(code!, binDir, ledger, artifactPath, 'Test');

      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('BLOCKED');
      // AC5: only first line of POLICY_STATE shown
      expect(r.stdout).toContain('denied-first-line');
      expect(r.stdout).not.toContain('stack-trace-line-2');
      expect(r.stdout).not.toContain('stack-trace-line-3');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Paid E2E: /office-hours builder mode exercises issue-artifacts via stub
// ---------------------------------------------------------------------------
// The SKILL.md uses hardcoded ~/.claude/skills/gstack/bin/ paths for all
// gstack binaries. We create a modified SKILL.md copy that rewrites those
// paths to use bare command names, then prepend our stub directory to PATH.
// This way the agent's bash blocks resolve stubs from PATH instead of the
// real install location.

function rewriteSkillPaths(skillMd: string): string {
  return skillMd
    .replace(/~\/\.claude\/skills\/gstack\/bin\//g, '')
    .replace(/\.claude\/skills\/gstack\/bin\//g, '');
}

function writeNoopStub(binDir: string, name: string) {
  const script = `#!/usr/bin/env bash\nexit 0\n`;
  const p = join(binDir, name);
  writeFileSync(p, script);
  chmodSync(p, 0o755);
}

describeIfSelected('AC4: paid E2E /office-hours builder + issue-artifacts', ['issue-artifact-e2e'], () => {
  let workDir: string;
  let binDir: string;
  let ledger: string;

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), 'e2e-issue-artifact-oh-'));
    const run = (cmd: string, args: string[]) =>
      spawnSync(cmd, args, { cwd: workDir, stdio: 'pipe', timeout: 5000 });

    run('git', ['init', '-b', 'main']);
    run('git', ['config', 'user.email', 'test@test.com']);
    run('git', ['config', 'user.name', 'Test']);

    // Stub bin directory prepended to PATH
    binDir = join(workDir, 'stub-bin');
    mkdirSync(binDir, { recursive: true });
    ledger = join(workDir, 'e2e-ledger.jsonl');

    // Issue-artifacts stubs (happy path)
    writeConfigStub(binDir, {
      issue_artifacts: 'on',
      issue_tracker: 'github',
      proactive: 'true',
      skill_prefix: 'false',
      telemetry: 'off',
      explain_level: 'default',
      question_tuning: 'false',
      routing_declined: 'false',
      checkpoint_mode: 'explicit',
      checkpoint_push: 'false',
      cross_project_learnings: 'false',
    });
    writeArtifactStub(binDir, {
      'detect-platform': { stdout: 'github', exit: 0 },
      create: { stdout: 'https://github.com/test/repo/issues/101', exit: 0 },
      'link-local': { stdout: 'ok', exit: 0 },
    });
    writePolicyStub(binDir, { stdout: 'allowed', exit: 0 });

    // Noop stubs for the many other gstack binaries referenced in SKILL.md
    const noopBins = [
      'gstack-update-check', 'gstack-repo-mode', 'gstack-telemetry-log',
      'gstack-slug', 'gstack-learnings-search', 'gstack-timeline-log',
      'gstack-question-preference', 'gstack-question-log', 'gstack-learnings-log',
      'gstack-brain-sync', 'gstack-builder-profile', 'gstack-paths',
      'gstack-review-read', 'gstack-team-init',
    ];
    for (const name of noopBins) writeNoopStub(binDir, name);

    // Rewritten SKILL.md: bare command names instead of absolute paths
    const rawSkill = readFileSync(join(ROOT, 'office-hours', 'SKILL.md'), 'utf-8');
    const rewritten = rewriteSkillPaths(rawSkill);
    mkdirSync(join(workDir, 'office-hours'), { recursive: true });
    writeFileSync(join(workDir, 'office-hours', 'SKILL.md'), rewritten);

    // Builder-idea fixture
    const idea = readFileSync(
      join(ROOT, 'test', 'fixtures', 'mode-posture', 'builder-idea.md'),
      'utf-8',
    );
    writeFileSync(join(workDir, 'idea.md'), idea);

    run('git', ['add', '.']);
    run('git', ['commit', '-m', 'scaffold']);
  });

  afterAll(() => {
    try { rmSync(workDir, { recursive: true, force: true }); } catch {}
  });

  testConcurrentIfSelected('issue-artifact-e2e', async () => {
    const result = await runSkillTest({
      prompt: `Read office-hours/SKILL.md for the workflow.

Read idea.md — that's the user's weekend project idea. Select Builder Mode (Phase 2B). Skip any AskUserQuestion — this is non-interactive. Auto-decide all questions with the recommended default.

The user confirmed the basic idea is "TypeScript + D3 web tool for dependency graph visualization." They want a design doc.

Write a short design document (3-5 paragraphs) to ${workDir}/design-doc.md with YAML frontmatter (title: "Dependency Graph Visualizer"). After writing the design doc, execute the issue-artifacts bash block from the SKILL.md. Set ISSUE_ARTIFACT_PATH="${workDir}/design-doc.md" and ISSUE_ARTIFACT_TITLE="Dependency Graph Visualizer" before running the block.

Do NOT create any GitHub issues for real — the gstack binaries in your PATH are stubs. Just run the bash block and let the stubs handle the rest.`,
      workingDirectory: workDir,
      maxTurns: 12,
      timeout: 300_000,
      testName: 'issue-artifact-e2e',
      runId,
      model: 'claude-sonnet-4-6',
      env: {
        PATH: `${binDir}:${process.env.PATH}`,
        STUB_GH_LEDGER: ledger,
      },
    });

    logCost('/office-hours (ISSUE-ARTIFACTS E2E)', result);
    recordE2E(evalCollector, '/office-hours-issue-artifacts-e2e', 'Office Hours Issue Artifacts E2E', result, {
      passed: ['success', 'error_max_turns'].includes(result.exitReason),
    });
    expect(['success', 'error_max_turns']).toContain(result.exitReason);

    // Verify the design doc was written
    const docPath = join(workDir, 'design-doc.md');
    expect(existsSync(docPath)).toBe(true);
    const docContent = readFileSync(docPath, 'utf-8');
    expect(docContent.length).toBeGreaterThan(50);

    // Verify the ledger was populated (stubs were called)
    const entries = readLedger(ledger);
    const artifactCalls = entries.filter(e => e.bin === 'gstack-issue-artifact');
    expect(artifactCalls.length).toBeGreaterThanOrEqual(1);

    // If link-local was called, verify the frontmatter stamp
    const linkEntry = entries.find(
      e => e.bin === 'gstack-issue-artifact' && e.argv[0] === 'link-local',
    );
    if (linkEntry) {
      const stamped = readFileSync(docPath, 'utf-8');
      expect(stamped).toContain('issue:');
      expect(stamped).toContain('issue-state: open');
    }
  }, 360_000);
});

// Finalize eval collector
if (evalsEnabled) {
  finalizeEvalCollector(evalCollector);
}
