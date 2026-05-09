/**
 * Issue-artifacts resolver — gate + discover blocks for issue-backed artifacts.
 *
 * Registered but not wired into any template yet (that's sub-issues #3/#4).
 * Both expansions emit config + policy gates as the FIRST executable lines,
 * before any gh/glab invocation.
 */
import type { TemplateContext } from './types';

export function generateIssueArtifactsBlock(ctx: TemplateContext): string {
  const bin = ctx.paths.binDir;
  return `## Issue-Backed Artifacts

Before any issue tracker operation, check both gates:

\`\`\`bash
ISSUE_MODE=$(${bin}/gstack-config get issue_artifacts)
if [[ "$ISSUE_MODE" == "off" ]]; then
  echo "[issue-artifacts] Disabled via config (issue_artifacts=off). Skipping."
  # Skip all issue operations in this skill run
fi

${bin}/gstack-issue-repo-policy check --op write
if [[ $? -ne 0 ]]; then
  echo "[issue-artifacts] Write blocked by repo policy. Skipping write operations."
  # Fall back to local-only mode for this skill run
fi
\`\`\`

When both gates pass, use the issue artifact helper for all tracker operations:

- **Create:** \`${bin}/gstack-issue-artifact create --kind <kind> --title "<title>" --body-file <path>\`
- **Update:** \`${bin}/gstack-issue-artifact update <number-or-url> --body-file <path>\`
- **Read:** \`${bin}/gstack-issue-artifact read <number-or-url>\`
- **Comment:** \`${bin}/gstack-issue-artifact comment <number-or-url> --body-file <path>\`
- **Close:** \`${bin}/gstack-issue-artifact close <number-or-url> [--comment-body-file <path>]\`
- **Link local:** \`${bin}/gstack-issue-artifact link-local --file <path> --issue <url>\`
- **List:** \`${bin}/gstack-issue-artifact list-by-label --label <label> [--state open|closed|all]\``;
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
