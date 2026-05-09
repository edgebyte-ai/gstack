/**
 * AC7 — Dual-role merge-order guard.
 *
 * The four dual-role templates (plan-ceo-review, plan-eng-review,
 * plan-design-review, plan-devex-review) carry ONLY {{ISSUE_ARTIFACTS_BLOCK}}
 * after this sub-issue (#3) lands. {{ISSUE_ARTIFACTS_DISCOVER}} is added by #4.
 *
 * This test asserts:
 * 1. Each dual-role template contains exactly one {{ISSUE_ARTIFACTS_BLOCK}}.
 * 2. Each dual-role template contains zero {{ISSUE_ARTIFACTS_DISCOVER}}.
 * 3. Each generated SKILL.md has the producer anchor markers exactly once.
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(import.meta.dir, '..');

const DUAL_ROLE_SKILLS = [
  'plan-ceo-review',
  'plan-eng-review',
  'plan-design-review',
  'plan-devex-review',
];

describe('AC7: dual-role template merge-order guard', () => {
  for (const skill of DUAL_ROLE_SKILLS) {
    describe(skill, () => {
      const tmplPath = join(ROOT, skill, 'SKILL.md.tmpl');
      const skillPath = join(ROOT, skill, 'SKILL.md');

      test('template contains exactly one {{ISSUE_ARTIFACTS_BLOCK}}', () => {
        const tmpl = readFileSync(tmplPath, 'utf-8');
        const matches = tmpl.match(/\{\{ISSUE_ARTIFACTS_BLOCK\}\}/g);
        expect(matches).not.toBeNull();
        expect(matches!.length).toBe(1);
      });

      test('template contains zero {{ISSUE_ARTIFACTS_DISCOVER}}', () => {
        const tmpl = readFileSync(tmplPath, 'utf-8');
        const matches = tmpl.match(/\{\{ISSUE_ARTIFACTS_DISCOVER\}\}/g);
        expect(matches).toBeNull();
      });

      test('generated SKILL.md has producer begin anchor exactly once', () => {
        const skill_md = readFileSync(skillPath, 'utf-8');
        const matches = skill_md.match(/<!-- @issue-artifacts:begin -->/g);
        expect(matches).not.toBeNull();
        expect(matches!.length).toBe(1);
      });

      test('generated SKILL.md has producer end anchor exactly once', () => {
        const skill_md = readFileSync(skillPath, 'utf-8');
        const matches = skill_md.match(/<!-- @issue-artifacts:end -->/g);
        expect(matches).not.toBeNull();
        expect(matches!.length).toBe(1);
      });

      test('generated SKILL.md does NOT contain discover-mode content', () => {
        const skill_md = readFileSync(skillPath, 'utf-8');
        expect(skill_md).not.toContain('## Discover Issue Artifacts');
      });
    });
  }
});
