/**
 * AC3 — Resolver shape constraint enforcement + behavioral off-gate tests.
 *
 * generateIssueArtifactsBlock MUST emit exactly ONE ```bash fenced code block
 * between <!-- @issue-artifacts:begin --> and <!-- @issue-artifacts:end -->
 * anchor markers. No prose between the anchors. This test breaks if the
 * resolver shape regresses.
 *
 * Behavioral section: exercises the generated bash block through stub shims
 * with per-test STUB_GH_LEDGER isolation (mkdtempSync), proving each
 * early-exit gate across all 8 producer skills. Ledger entries provide
 * argument-level call records for assertions.
 */
import { describe, test, expect } from 'bun:test';
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

const PRODUCER_SKILLS = [
  'office-hours',
  'plan-ceo-review',
  'plan-eng-review',
  'plan-design-review',
  'plan-devex-review',
  'design-consultation',
  'retro',
  'context-save',
] as const;

const SKILL_KIND_MAP: Record<string, { kind: string; extraLabels?: string[] }> = {
  'office-hours':        { kind: 'gstack:design-doc' },
  'plan-ceo-review':     { kind: 'gstack:ceo-plan' },
  'plan-eng-review':     { kind: 'gstack:eng-plan' },
  'plan-design-review':  { kind: 'gstack:design-plan' },
  'plan-devex-review':   { kind: 'gstack:devex-plan' },
  'design-consultation': { kind: 'gstack:design-doc', extraLabels: ['design-system'] },
  'retro':               { kind: 'gstack:retro' },
  'context-save':        { kind: 'gstack:context-save' },
};

function makeCtx(skillName: string): TemplateContext {
  return {
    skillName,
    tmplPath: `${skillName}/SKILL.md.tmpl`,
    host: 'claude' as any,
    paths: MOCK_PATHS,
  };
}

// ---------------------------------------------------------------------------
// AST-walk anchor extraction (replaces indexOf/slice approach)
// ---------------------------------------------------------------------------

/**
 * Walk the full marked AST to find the bash code block between anchor HTML
 * comment tokens. Returns null if anchors are missing or the region between
 * them doesn't contain exactly one fenced code block.
 */
function extractAnchoredBashBlock(output: string): { code: string; lang: string } | null {
  const tokens = marked.lexer(output);
  let insideAnchors = false;
  const anchored: marked.Token[] = [];

  for (const token of tokens) {
    if (token.type === 'html' && token.text.includes('<!-- @issue-artifacts:begin -->')) {
      insideAnchors = true;
      continue;
    }
    if (insideAnchors && token.type === 'html' && token.text.includes('<!-- @issue-artifacts:end -->')) {
      break;
    }
    if (insideAnchors) {
      anchored.push(token);
    }
  }

  const codeTokens = anchored.filter((t): t is marked.Tokens.Code => t.type === 'code');
  if (codeTokens.length !== 1) return null;
  return { code: codeTokens[0].text, lang: codeTokens[0].lang || '' };
}

/**
 * AST-walk check: returns non-code, non-space tokens between anchors.
 * Empty array means clean (no prose leaking into the anchored region).
 */
function proseTokensBetweenAnchors(output: string): marked.Token[] {
  const tokens = marked.lexer(output);
  let inside = false;
  const prose: marked.Token[] = [];

  for (const token of tokens) {
    if (token.type === 'html' && token.text.includes('<!-- @issue-artifacts:begin -->')) {
      inside = true;
      continue;
    }
    if (inside && token.type === 'html' && token.text.includes('<!-- @issue-artifacts:end -->')) {
      break;
    }
    if (inside && token.type !== 'code' && token.type !== 'space') {
      prose.push(token);
    }
  }
  return prose;
}

// ---------------------------------------------------------------------------
// Shape constraint tests
// ---------------------------------------------------------------------------

describe('AC3: ISSUE_ARTIFACTS_BLOCK shape constraint', () => {
  for (const skill of PRODUCER_SKILLS) {
    test(`${skill}: output contains begin/end anchors`, () => {
      const output = generateIssueArtifactsBlock(makeCtx(skill));
      expect(output).toContain('<!-- @issue-artifacts:begin -->');
      expect(output).toContain('<!-- @issue-artifacts:end -->');
    });

    test(`${skill}: exactly one bash code block between anchors (AST walk)`, () => {
      const output = generateIssueArtifactsBlock(makeCtx(skill));
      const result = extractAnchoredBashBlock(output);
      expect(result).not.toBeNull();
      expect(result!.lang).toBe('bash');
      expect(result!.code.length).toBeGreaterThan(0);
    });

    test(`${skill}: no prose between anchors (AST walk)`, () => {
      const output = generateIssueArtifactsBlock(makeCtx(skill));
      expect(proseTokensBetweenAnchors(output)).toHaveLength(0);
    });
  }

  test('narrative text lives OUTSIDE (before) the begin anchor', () => {
    const tokens = marked.lexer(generateIssueArtifactsBlock(makeCtx('office-hours')));
    let foundAnchor = false;
    let preAnchorContent = false;
    for (const token of tokens) {
      if (token.type === 'html' && token.text.includes('<!-- @issue-artifacts:begin -->')) {
        foundAnchor = true;
        break;
      }
      if (token.type !== 'space') preAnchorContent = true;
    }
    expect(foundAnchor).toBe(true);
    expect(preAnchorContent).toBe(true);
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
// Behavioral off-gate tests — stub shims with STUB_GH_LEDGER isolation
// ---------------------------------------------------------------------------

interface ScenarioRow {
  description: string;
  stubs: {
    'gstack-config': Record<string, string>;
    'gstack-issue-artifact': {
      'detect-platform': { stdout: string; exit: number };
      create: { stdout: string; stderr?: string; exit: number };
      'link-local': { stdout: string; stderr?: string; exit: number };
    };
    'gstack-issue-repo-policy': { stdout: string; exit: number };
  };
  expected: {
    exitCode: number;
    stdoutContains: string[];
    stdoutNotContains: string[];
  };
}

interface LedgerEntry {
  ts: string;
  bin: string;
  argv: string[];
  response_code: number;
}

const SCENARIO_DIR = join(process.cwd(), 'test', 'fixtures', 'issue-artifacts', 'scenarios');

function loadScenario(filename: string): ScenarioRow {
  return JSON.parse(readFileSync(join(SCENARIO_DIR, filename), 'utf-8'));
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
    ${ll.stderr ? `echo "${ll.stderr}" >&2` : ':'}
    echo "${ll.stdout}"
    exit ${ll.exit}
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

function runBashBlock(
  code: string,
  binDir: string,
  ledger: string,
): { stdout: string; stderr: string; exitCode: number } {
  const result = Bun.spawnSync({
    cmd: ['bash', '-c', code],
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      ISSUE_ARTIFACT_PATH: '/tmp/test-artifact.md',
      ISSUE_ARTIFACT_TITLE: 'Test Artifact',
      STUB_GH_LEDGER: ledger,
    },
  });
  return {
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString().trim(),
    exitCode: result.exitCode,
  };
}

function getBlockForSkill(skill: string, binDir: string): string {
  const ctx = makeCtx(skill);
  ctx.paths = { ...MOCK_PATHS, binDir: '__BINDIR__' };
  const output = generateIssueArtifactsBlock(ctx);
  const result = extractAnchoredBashBlock(output);
  if (!result) throw new Error(`Failed to extract bash block for ${skill}`);
  return result.code.replaceAll('__BINDIR__', binDir);
}

// Scenario fixture files (one per row of the matrix)
const SCENARIO_ROWS = [
  { name: 'row1-disabled',        file: 'off-gate-row1-disabled.json' },
  { name: 'row2-tracker-none',    file: 'off-gate-row2-tracker-none.json' },
  { name: 'row3-platform-none',   file: 'off-gate-row3-platform-none.json' },
  { name: 'row4-policy-blocked',  file: 'off-gate-row4-policy-blocked.json' },
  { name: 'row5-create-fail',     file: 'off-gate-row5-create-fail.json' },
  { name: 'row6-happy',           file: 'off-gate-row6-happy.json' },
  { name: 'row7-linklocal-fail',  file: 'off-gate-row7-linklocal-fail.json' },
] as const;

describe('AC3: behavioral off-gate (stub shim + STUB_GH_LEDGER)', () => {
  for (const skill of PRODUCER_SKILLS) {
    describe(skill, () => {
      for (const row of SCENARIO_ROWS) {
        test(`${row.name}`, () => {
          const tmpDir = mkdtempSync(join(tmpdir(), `off-gate-${skill}-${row.name}-`));
          try {
            const binDir = makeBinDir(tmpDir);
            const ledger = join(tmpDir, 'recorded-calls.jsonl');
            const scenario = loadScenario(row.file);

            writeConfigStub(binDir, scenario.stubs['gstack-config']);
            writeArtifactStub(binDir, scenario.stubs['gstack-issue-artifact']);
            writePolicyStub(binDir, scenario.stubs['gstack-issue-repo-policy']);

            const code = getBlockForSkill(skill, binDir);
            const r = runBashBlock(code, binDir, ledger);

            // Exit code assertion
            expect(r.exitCode).toBe(scenario.expected.exitCode);

            // Stdout assertions from fixture
            for (const s of scenario.expected.stdoutContains) {
              expect(r.stdout).toContain(s);
            }
            for (const s of scenario.expected.stdoutNotContains) {
              expect(r.stdout).not.toContain(s);
            }

            // Ledger isolation: file exists at per-test path
            const entries = readLedger(ledger);

            // Row-specific ledger + skill-specific assertions
            const skillMeta = SKILL_KIND_MAP[skill] ?? { kind: 'gstack:design-doc' };

            if (row.name === 'row1-disabled') {
              // Off gate: only gstack-config called, exits before anything else
              expect(entries.some(e => e.bin === 'gstack-config')).toBe(true);
              expect(entries.some(e => e.bin === 'gstack-issue-artifact' && e.argv[0] === 'create')).toBe(false);
            }

            if (row.name === 'row2-tracker-none') {
              expect(entries.some(e => e.bin === 'gstack-config')).toBe(true);
              expect(entries.some(e => e.bin === 'gstack-issue-artifact' && e.argv[0] === 'create')).toBe(false);
            }

            if (row.name === 'row3-platform-none') {
              expect(entries.some(e => e.bin === 'gstack-issue-artifact' && e.argv[0] === 'detect-platform')).toBe(true);
              expect(entries.some(e => e.bin === 'gstack-issue-artifact' && e.argv[0] === 'create')).toBe(false);
            }

            if (row.name === 'row4-policy-blocked') {
              expect(entries.some(e => e.bin === 'gstack-issue-repo-policy')).toBe(true);
              expect(entries.filter(e => e.bin === 'gstack-issue-repo-policy')[0]?.response_code).toBe(1);
              expect(entries.some(e => e.bin === 'gstack-issue-artifact' && e.argv[0] === 'create')).toBe(false);
            }

            if (row.name === 'row5-create-fail') {
              const createEntry = entries.find(e => e.bin === 'gstack-issue-artifact' && e.argv[0] === 'create');
              expect(createEntry).toBeDefined();
              expect(createEntry!.response_code).toBe(1);
              expect(createEntry!.argv).toContain('--kind');
              expect(createEntry!.argv).toContain(skillMeta.kind);
            }

            if (row.name === 'row6-happy') {
              // Verify create was called with correct kind
              const createEntry = entries.find(e => e.bin === 'gstack-issue-artifact' && e.argv[0] === 'create');
              expect(createEntry).toBeDefined();
              expect(createEntry!.argv).toContain('--kind');
              expect(createEntry!.argv).toContain(skillMeta.kind);

              if (skillMeta.extraLabels?.length) {
                for (const label of skillMeta.extraLabels) {
                  expect(createEntry!.argv).toContain(label);
                }
              }

              // Verify link-local was called
              const linkEntry = entries.find(e => e.bin === 'gstack-issue-artifact' && e.argv[0] === 'link-local');
              expect(linkEntry).toBeDefined();
              expect(linkEntry!.response_code).toBe(0);

              // Verify published message includes skill kind
              expect(r.stdout).toContain(`published ${skillMeta.kind}`);
            }

            if (row.name === 'row7-linklocal-fail') {
              const createEntry = entries.find(e => e.bin === 'gstack-issue-artifact' && e.argv[0] === 'create');
              expect(createEntry).toBeDefined();
              expect(createEntry!.argv).toContain(skillMeta.kind);

              const linkEntry = entries.find(e => e.bin === 'gstack-issue-artifact' && e.argv[0] === 'link-local');
              expect(linkEntry).toBeDefined();
              expect(linkEntry!.response_code).toBe(1);

              expect(r.stdout).not.toContain('published');
            }
          } finally {
            rmSync(tmpDir, { recursive: true, force: true });
          }
        });
      }
    });
  }
});
