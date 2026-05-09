/**
 * AC3 — Resolver shape constraint enforcement + behavioral off-gate tests.
 *
 * generateIssueArtifactsBlock MUST emit exactly ONE ```bash fenced code block
 * between <!-- @issue-artifacts:begin --> and <!-- @issue-artifacts:end -->
 * anchor markers. No prose between the anchors. This test breaks if the
 * resolver shape regresses.
 *
 * Behavioral section: exercises the generated bash block through stub shims
 * with per-test temporary ledgers, proving each early-exit gate.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { generateIssueArtifactsBlock } from '../scripts/resolvers/issue-artifacts';
import type { TemplateContext, HostPaths } from '../scripts/resolvers/types';
import { marked } from 'marked';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, chmodSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const MOCK_PATHS: HostPaths = {
  skillRoot: '~/.claude/skills/gstack',
  localSkillRoot: '.claude/skills',
  binDir: '~/.claude/skills/gstack/bin',
  browseDir: '~/.claude/skills/gstack/browse/dist',
  designDir: '~/.claude/skills/gstack/design/dist',
  makePdfDir: '~/.claude/skills/gstack/make-pdf/dist',
};

function makeCtx(skillName: string): TemplateContext {
  return {
    skillName,
    tmplPath: `${skillName}/SKILL.md.tmpl`,
    host: 'claude' as any,
    paths: MOCK_PATHS,
  };
}

/**
 * Extract the bash code block between anchor markers using `marked` lexer.
 * Returns the raw code text (no fences, no language tag).
 */
function extractAnchoredBashBlock(output: string): { code: string; lang: string } | null {
  const beginAnchor = '<!-- @issue-artifacts:begin -->';
  const endAnchor = '<!-- @issue-artifacts:end -->';
  const beginIdx = output.indexOf(beginAnchor);
  const endIdx = output.indexOf(endAnchor);
  if (beginIdx === -1 || endIdx === -1) return null;

  const between = output.slice(beginIdx + beginAnchor.length, endIdx);
  const tokens = marked.lexer(between);
  const codeTokens = tokens.filter((t): t is marked.Tokens.Code => t.type === 'code');
  if (codeTokens.length !== 1) return null;
  return { code: codeTokens[0].text, lang: codeTokens[0].lang || '' };
}

describe('AC3: ISSUE_ARTIFACTS_BLOCK shape constraint', () => {
  const PRODUCER_SKILLS = [
    'office-hours',
    'plan-ceo-review',
    'plan-eng-review',
    'plan-design-review',
    'plan-devex-review',
    'design-consultation',
    'retro',
    'context-save',
  ];

  for (const skill of PRODUCER_SKILLS) {
    test(`${skill}: output contains begin/end anchors`, () => {
      const output = generateIssueArtifactsBlock(makeCtx(skill));
      expect(output).toContain('<!-- @issue-artifacts:begin -->');
      expect(output).toContain('<!-- @issue-artifacts:end -->');
    });

    test(`${skill}: exactly one bash code block between anchors (via marked)`, () => {
      const output = generateIssueArtifactsBlock(makeCtx(skill));
      const result = extractAnchoredBashBlock(output);
      expect(result).not.toBeNull();
      expect(result!.lang).toBe('bash');
      expect(result!.code.length).toBeGreaterThan(0);
    });

    test(`${skill}: no prose between anchors (only whitespace + fenced block)`, () => {
      const output = generateIssueArtifactsBlock(makeCtx(skill));
      const beginAnchor = '<!-- @issue-artifacts:begin -->';
      const endAnchor = '<!-- @issue-artifacts:end -->';
      const between = output.slice(
        output.indexOf(beginAnchor) + beginAnchor.length,
        output.indexOf(endAnchor),
      );
      const tokens = marked.lexer(between);
      const nonSpaceNonCode = tokens.filter(
        t => t.type !== 'code' && t.type !== 'space',
      );
      expect(nonSpaceNonCode).toHaveLength(0);
    });
  }

  test('narrative text lives OUTSIDE (before) the begin anchor', () => {
    const output = generateIssueArtifactsBlock(makeCtx('office-hours'));
    const beginIdx = output.indexOf('<!-- @issue-artifacts:begin -->');
    const preamble = output.slice(0, beginIdx);
    expect(preamble.trim().length).toBeGreaterThan(0);
  });

  test('uses correct kind for known skill', () => {
    const output = generateIssueArtifactsBlock(makeCtx('retro'));
    expect(output).toContain('--kind gstack:retro');
  });

  test('uses default kind for unknown skill', () => {
    const output = generateIssueArtifactsBlock(makeCtx('unknown-skill'));
    expect(output).toContain('--kind gstack:design-doc');
  });

  test('includes extra labels for design-consultation', () => {
    const output = generateIssueArtifactsBlock(makeCtx('design-consultation'));
    expect(output).toContain('--label design-system');
  });

  test('references ISSUE_ARTIFACT_PATH and ISSUE_ARTIFACT_TITLE', () => {
    const output = generateIssueArtifactsBlock(makeCtx('office-hours'));
    expect(output).toContain('$ISSUE_ARTIFACT_PATH');
    expect(output).toContain('$ISSUE_ARTIFACT_TITLE');
  });

  test('gstack-config off gate is first check', () => {
    const result = extractAnchoredBashBlock(generateIssueArtifactsBlock(makeCtx('office-hours')));
    expect(result).not.toBeNull();
    const offGateIdx = result!.code.indexOf('issue_artifacts');
    const trackerIdx = result!.code.indexOf('issue_tracker');
    expect(offGateIdx).toBeLessThan(trackerIdx);
  });
});

// ---------------------------------------------------------------------------
// Behavioral off-gate tests — exercises generated bash via stub shims
// ---------------------------------------------------------------------------

describe('AC3: behavioral off-gate (stub shim)', () => {
  const STUB_DIR = join(process.cwd(), 'test', 'fixtures', 'issue-artifacts');

  function makeBinDir(tmpDir: string): string {
    const binDir = join(tmpDir, 'bin');
    mkdirSync(binDir, { recursive: true });
    return binDir;
  }

  /**
   * Write a stub `gstack-config` that returns a given value for a key.
   * configMap: { issue_artifacts: "off", issue_tracker: "github" }
   */
  function writeConfigStub(binDir: string, configMap: Record<string, string>) {
    const script = `#!/usr/bin/env bash
case "$2" in
${Object.entries(configMap).map(([k, v]) => `  ${k}) echo "${v}" ;;`).join('\n')}
  *) echo "unknown" ;;
esac
`;
    const path = join(binDir, 'gstack-config');
    writeFileSync(path, script);
    chmodSync(path, 0o755);
  }

  /**
   * Write a stub `gstack-issue-artifact` that dispatches on the first arg.
   */
  function writeArtifactStub(
    binDir: string,
    opts: {
      detectPlatform?: { stdout: string; exit: number };
      create?: { stdout: string; stderr?: string; exit: number };
      linkLocal?: { stdout: string; stderr?: string; exit: number };
    },
  ) {
    const dp = opts.detectPlatform ?? { stdout: 'github', exit: 0 };
    const cr = opts.create ?? { stdout: 'https://github.com/test/repo/issues/99', stderr: '', exit: 0 };
    const ll = opts.linkLocal ?? { stdout: '', stderr: '', exit: 0 };
    const script = `#!/usr/bin/env bash
case "$1" in
  detect-platform)
    echo "${dp.stdout}"
    exit ${dp.exit}
    ;;
  create)
    if [[ -n "${cr.stderr ?? ''}" ]]; then echo "${cr.stderr ?? ''}" >&2; fi
    echo "${cr.stdout}"
    exit ${cr.exit}
    ;;
  link-local)
    if [[ -n "${ll.stderr ?? ''}" ]]; then echo "${ll.stderr ?? ''}" >&2; fi
    echo "${ll.stdout}"
    exit ${ll.exit}
    ;;
  *) echo "unknown subcommand: $1" >&2; exit 1 ;;
esac
`;
    const path = join(binDir, 'gstack-issue-artifact');
    writeFileSync(path, script);
    chmodSync(path, 0o755);
  }

  /**
   * Write a stub `gstack-issue-repo-policy`.
   */
  function writePolicyStub(binDir: string, opts: { stdout: string; exit: number }) {
    const script = `#!/usr/bin/env bash
# stub for gstack-issue-repo-policy check --op write
echo "${opts.stdout}"
exit ${opts.exit}
`;
    const filePath = join(binDir, 'gstack-issue-repo-policy');
    writeFileSync(filePath, script);
    chmodSync(filePath, 0o755);
  }

  function runBashBlock(code: string, binDir: string): { stdout: string; stderr: string; exitCode: number } {
    const result = Bun.spawnSync({
      cmd: ['bash', '-c', code],
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        ISSUE_ARTIFACT_PATH: '/tmp/test-artifact.md',
        ISSUE_ARTIFACT_TITLE: 'Test Artifact',
      },
    });
    return {
      stdout: result.stdout.toString().trim(),
      stderr: result.stderr.toString().trim(),
      exitCode: result.exitCode,
    };
  }

  function getBlock(): string {
    const ctx = makeCtx('office-hours');
    ctx.paths = { ...MOCK_PATHS, binDir: '__BINDIR__' };
    const output = generateIssueArtifactsBlock(ctx);
    const result = extractAnchoredBashBlock(output);
    if (!result) throw new Error('Failed to extract bash block');
    return result.code;
  }

  test('row 1 — off gate: issue_artifacts=off exits immediately', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'off-gate-off-'));
    try {
      const binDir = makeBinDir(tmpDir);
      writeConfigStub(binDir, { issue_artifacts: 'off', issue_tracker: 'github' });
      writeArtifactStub(binDir, {});
      writePolicyStub(binDir, { stdout: 'allowed', exit: 0 });

      const code = getBlock().replaceAll('__BINDIR__', binDir);
      const r = runBashBlock(code, binDir);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('row 2 — tracker=none: prints FALLBACK and exits', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'off-gate-tracker-'));
    try {
      const binDir = makeBinDir(tmpDir);
      writeConfigStub(binDir, { issue_artifacts: 'on', issue_tracker: 'none' });
      writeArtifactStub(binDir, {});
      writePolicyStub(binDir, { stdout: 'allowed', exit: 0 });

      const code = getBlock().replaceAll('__BINDIR__', binDir);
      const r = runBashBlock(code, binDir);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('[issue-artifacts] FALLBACK: tracker disabled');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('row 3 — platform=none: prints FALLBACK and exits', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'off-gate-platform-'));
    try {
      const binDir = makeBinDir(tmpDir);
      writeConfigStub(binDir, { issue_artifacts: 'on', issue_tracker: 'github' });
      writeArtifactStub(binDir, { detectPlatform: { stdout: 'none', exit: 0 } });
      writePolicyStub(binDir, { stdout: 'allowed', exit: 0 });

      const code = getBlock().replaceAll('__BINDIR__', binDir);
      const r = runBashBlock(code, binDir);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('[issue-artifacts] FALLBACK: no tracker detected');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('row 4 — policy blocked: prints BLOCKED and exits', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'off-gate-policy-'));
    try {
      const binDir = makeBinDir(tmpDir);
      writeConfigStub(binDir, { issue_artifacts: 'on', issue_tracker: 'github' });
      writeArtifactStub(binDir, {});
      writePolicyStub(binDir, { stdout: 'read-only', exit: 1 });

      const code = getBlock().replaceAll('__BINDIR__', binDir);
      const r = runBashBlock(code, binDir);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('[issue-artifacts] BLOCKED: repo policy');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('row 5 — create failure: prints FALLBACK with error text', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'off-gate-create-'));
    try {
      const binDir = makeBinDir(tmpDir);
      writeConfigStub(binDir, { issue_artifacts: 'on', issue_tracker: 'github' });
      writeArtifactStub(binDir, {
        create: { stdout: '', stderr: 'gh: HTTP 403', exit: 1 },
      });
      writePolicyStub(binDir, { stdout: 'allowed', exit: 0 });

      const code = getBlock().replaceAll('__BINDIR__', binDir);
      const r = runBashBlock(code, binDir);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('[issue-artifacts] FALLBACK:');
      expect(r.stderr).not.toContain('gh: HTTP 403');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('row 6 — positive control: happy path publishes', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'off-gate-happy-'));
    try {
      const binDir = makeBinDir(tmpDir);
      writeConfigStub(binDir, { issue_artifacts: 'on', issue_tracker: 'github' });
      writeArtifactStub(binDir, {
        create: { stdout: 'https://github.com/test/repo/issues/99', exit: 0 },
        linkLocal: { stdout: 'ok', exit: 0 },
      });
      writePolicyStub(binDir, { stdout: 'allowed', exit: 0 });

      const code = getBlock().replaceAll('__BINDIR__', binDir);
      const r = runBashBlock(code, binDir);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('[issue-artifacts] published gstack:design-doc -> https://github.com/test/repo/issues/99');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('row 5b — link-local failure: prints FALLBACK, no false-positive publish', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'off-gate-linklocal-'));
    try {
      const binDir = makeBinDir(tmpDir);
      writeConfigStub(binDir, { issue_artifacts: 'on', issue_tracker: 'github' });
      writeArtifactStub(binDir, {
        create: { stdout: 'https://github.com/test/repo/issues/99', exit: 0 },
        linkLocal: { stdout: '', stderr: 'frontmatter write failed', exit: 1 },
      });
      writePolicyStub(binDir, { stdout: 'allowed', exit: 0 });

      const code = getBlock().replaceAll('__BINDIR__', binDir);
      const r = runBashBlock(code, binDir);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('[issue-artifacts] FALLBACK: link-local failed');
      expect(r.stdout).not.toContain('[issue-artifacts] published');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
