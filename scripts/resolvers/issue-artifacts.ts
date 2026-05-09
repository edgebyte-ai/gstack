/**
 * Issue-artifacts resolver — gate + discover blocks for issue-backed artifacts.
 *
 * SHAPE CONSTRAINT (AC3, issue #3):
 * generateIssueArtifactsBlock MUST emit exactly ONE ```bash fenced code block
 * between <!-- @issue-artifacts:begin --> and <!-- @issue-artifacts:end -->
 * anchor markers. No prose, no second fenced block, no shell-incompatible
 * instructions between the anchors. Narrative/rationale lives OUTSIDE the
 * anchors. This constraint is enforced by:
 *   - test/issue-artifacts-off-gate.test.ts (AC3, this repo)
 *   - test/fixtures/issue-artifacts/ stub-shim contract test (#2 AC8)
 * A regression in resolver shape fails BOTH tests.
 */
import type { TemplateContext } from './types';

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

export function generateIssueArtifactsBlock(ctx: TemplateContext): string {
  const bin = ctx.paths.binDir;
  const mapping = SKILL_KIND_MAP[ctx.skillName];
  const kind = mapping?.kind ?? 'gstack:design-doc';
  const extraLabelFlags = mapping?.extraLabels
    ? mapping.extraLabels.map(l => ` --label ${l}`).join('')
    : '';

  const bashBlock = [
    `ISSUE_MODE=$(${bin}/gstack-config get issue_artifacts)`,
    `if [[ "$ISSUE_MODE" == "off" ]]; then exit 0; fi`,
    ``,
    `ISSUE_TRACKER=$(${bin}/gstack-config get issue_tracker)`,
    `if [[ "$ISSUE_TRACKER" == "none" ]]; then`,
    `  echo "[issue-artifacts] FALLBACK: tracker disabled by config"`,
    `  exit 0`,
    `fi`,
    ``,
    `PLATFORM=$(${bin}/gstack-issue-artifact detect-platform)`,
    `if [[ "$PLATFORM" == "none" ]]; then`,
    `  echo "[issue-artifacts] FALLBACK: no tracker detected"`,
    `  exit 0`,
    `fi`,
    ``,
    `POLICY_STATE=$(${bin}/gstack-issue-repo-policy check --op write 2>&1) || {`,
    `  echo "[issue-artifacts] BLOCKED: repo policy = $POLICY_STATE"`,
    `  exit 0`,
    `}`,
    ``,
    `ISSUE_URL=$(${bin}/gstack-issue-artifact create --kind ${kind}${extraLabelFlags} \\`,
    `  --title "$ISSUE_ARTIFACT_TITLE" \\`,
    `  --body-file "$ISSUE_ARTIFACT_PATH" 2>&1) || {`,
    `  echo "[issue-artifacts] FALLBACK: $(echo "$ISSUE_URL" | head -1)"`,
    `  exit 0`,
    `}`,
    ``,
    `LINK_OUT=$(${bin}/gstack-issue-artifact link-local --file "$ISSUE_ARTIFACT_PATH" --issue "$ISSUE_URL" 2>&1) || {`,
    `  echo "[issue-artifacts] FALLBACK: link-local failed: $(echo "$LINK_OUT" | head -1)"`,
    `  exit 0`,
    `}`,
    `echo "[issue-artifacts] published ${kind} -> $ISSUE_URL"`,
  ].join('\n');

  return `After writing the local artifact file, publish it to the issue tracker. Set two shell variables before running the block: \`ISSUE_ARTIFACT_PATH\` (absolute path to the local file just written) and \`ISSUE_ARTIFACT_TITLE\` (human-readable title for the issue).

<!-- @issue-artifacts:begin -->
\`\`\`bash
${bashBlock}
\`\`\`
<!-- @issue-artifacts:end -->`;
}

export function generateIssueArtifactsDiscover(ctx: TemplateContext): string {
  const bin = ctx.paths.binDir;
  return `## Discover Issue Artifacts

Check if issue-backed artifacts are available for this project:

\`\`\`bash
ISSUE_MODE=$(${bin}/gstack-config get issue_artifacts)
if [[ "$ISSUE_MODE" == "off" ]]; then
  echo "[issue-artifacts] Disabled."
else
  PLATFORM=$(${bin}/gstack-issue-artifact detect-platform)
  if [[ "$PLATFORM" == "none" ]]; then
    echo "[issue-artifacts] No issue tracker detected for this repo."
  else
    ${bin}/gstack-issue-repo-policy check --op read
    if [[ $? -ne 0 ]]; then
      echo "[issue-artifacts] Read blocked by repo policy."
    else
      echo "[issue-artifacts] Available on $PLATFORM. Use gstack-issue-artifact to interact."
    fi
  fi
fi
\`\`\``;
}

export const CANONICAL_LABELS = [
  "gstack:design-doc",
  "gstack:ceo-plan",
  "gstack:eng-plan",
  "gstack:design-plan",
  "gstack:devex-plan",
  "gstack:retro",
  "gstack:context-save",
  "gstack:todo",
  "gstack:review-finding",
];
