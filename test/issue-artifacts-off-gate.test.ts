/**
 * AC3 — Resolver shape constraint enforcement.
 *
 * generateIssueArtifactsBlock MUST emit exactly ONE ```bash fenced code block
 * between <!-- @issue-artifacts:begin --> and <!-- @issue-artifacts:end -->
 * anchor markers. No prose between the anchors. This test breaks if the
 * resolver shape regresses.
 */
import { describe, test, expect } from 'bun:test';
import { generateIssueArtifactsBlock } from '../scripts/resolvers/issue-artifacts';
import type { TemplateContext, HostPaths } from '../scripts/resolvers/types';

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

    test(`${skill}: exactly one fenced code block between anchors`, () => {
      const output = generateIssueArtifactsBlock(makeCtx(skill));
      const beginIdx = output.indexOf('<!-- @issue-artifacts:begin -->');
      const endIdx = output.indexOf('<!-- @issue-artifacts:end -->');
      const between = output.slice(beginIdx + '<!-- @issue-artifacts:begin -->'.length, endIdx);

      const fenceMatches = between.match(/```/g);
      expect(fenceMatches).not.toBeNull();
      expect(fenceMatches!.length).toBe(2); // opening ```bash + closing ```
    });

    test(`${skill}: no prose between anchors (only whitespace + fenced block)`, () => {
      const output = generateIssueArtifactsBlock(makeCtx(skill));
      const beginIdx = output.indexOf('<!-- @issue-artifacts:begin -->');
      const endIdx = output.indexOf('<!-- @issue-artifacts:end -->');
      const between = output.slice(beginIdx + '<!-- @issue-artifacts:begin -->'.length, endIdx);

      const beforeFence = between.slice(0, between.indexOf('```'));
      const afterFence = between.slice(between.lastIndexOf('```') + 3);
      expect(beforeFence.trim()).toBe('');
      expect(afterFence.trim()).toBe('');
    });

    test(`${skill}: fenced block uses bash language tag`, () => {
      const output = generateIssueArtifactsBlock(makeCtx(skill));
      const beginIdx = output.indexOf('<!-- @issue-artifacts:begin -->');
      const endIdx = output.indexOf('<!-- @issue-artifacts:end -->');
      const between = output.slice(beginIdx + '<!-- @issue-artifacts:begin -->'.length, endIdx);

      expect(between).toContain('```bash');
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
    const output = generateIssueArtifactsBlock(makeCtx('office-hours'));
    const beginIdx = output.indexOf('<!-- @issue-artifacts:begin -->');
    const between = output.slice(beginIdx);
    const offGateIdx = between.indexOf('issue_artifacts');
    const trackerIdx = between.indexOf('issue_tracker');
    expect(offGateIdx).toBeLessThan(trackerIdx);
  });
});
