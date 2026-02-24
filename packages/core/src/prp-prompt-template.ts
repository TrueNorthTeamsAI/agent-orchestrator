/**
 * PRP Prompt Template — generates PRP lifecycle instructions for spawned agents.
 *
 * When a project has PRP enabled, this prompt is written to a systemPromptFile
 * and passed via --append-system-prompt. It instructs the agent to follow the
 * investigate -> plan -> implement -> PR -> self-review lifecycle.
 */

import type { PrpConfig } from "./types.js";

// =============================================================================
// TYPES
// =============================================================================

export interface PrpPromptConfig {
  /** The PRP configuration for this project */
  prp: PrpConfig;

  /** Issue identifier (e.g. "#42", "INT-1343") */
  issueId: string;

  /** Project name for display */
  projectName: string;
}

// =============================================================================
// PRP LIFECYCLE PROMPT
// =============================================================================

export const PRP_LIFECYCLE_PROMPT = `## PRP Methodology — Structured Agent Lifecycle

You have the PRP (Product Requirement Prompt) plugin installed. You MUST follow this structured lifecycle for every task. DO NOT skip steps or improvise your own approach.

### Lifecycle Steps

Follow these steps IN ORDER. Each step uses a PRP plugin command.

**Step 1: Investigate**
Run the investigation command to understand the issue deeply before writing any code.
This creates an investigation artifact in \`.claude/PRPs/investigations/\`.

**Step 2: Plan**
Create an implementation plan based on your investigation findings.
This creates a plan artifact in \`.claude/PRPs/plans/\`.

**Step 3: Implement (Ralph Loop)**
Execute the plan using the autonomous validation loop.
Ralph iterates until all validations pass: lint, typecheck, tests, build.
DO NOT manually implement without the validation loop.

**Step 4: Create PR**
Create a pull request with a summary of changes, test plan, and linked issue.

**Step 5: Self-Review**
Review your own PR for quality, completeness, and adherence to the plan.
Address any issues found before marking as ready.

### Rules

- NEVER skip the investigation step — understanding the problem is critical
- NEVER start coding before creating a plan
- ALWAYS use the validation loop — do not push untested code
- If the validation loop fails after multiple iterations, document the blocker
- Commit PRP artifacts (\`.claude/PRPs/\`) alongside your code changes`;

// =============================================================================
// PUBLIC API
// =============================================================================

/**
 * Build a PRP lifecycle prompt for an agent session.
 *
 * Returns a markdown string with:
 * 1. PRP lifecycle instructions (the constant above)
 * 2. Issue-specific commands with the actual issue ID
 * 3. Gate instructions if human approval is configured
 */
export function buildPrpPrompt(config: PrpPromptConfig): string {
  const { prp, issueId, projectName } = config;
  const sections: string[] = [];

  // Section 1: Lifecycle instructions
  sections.push(PRP_LIFECYCLE_PROMPT);

  // Section 2: Issue-specific commands
  sections.push(`## Your Task

Project: ${projectName}
Issue: ${issueId}

Execute these commands in order:

\`\`\`
/prp-issue-investigate ${issueId}
/prp-plan .claude/PRPs/investigations/<investigation-file>.md
/prp-ralph .claude/PRPs/plans/<plan-file>.plan.md
/prp-pr
/prp-review
\`\`\`

After \`/prp-issue-investigate\`, the investigation file will be in \`.claude/PRPs/investigations/\`.
After \`/prp-plan\`, the plan file will be in \`.claude/PRPs/plans/\`.
Use the actual file paths from the previous step's output.`);

  // Section 3: Gate instructions (conditional)
  if (prp.gates.plan) {
    sections.push(`## Plan Approval Gate

IMPORTANT: After creating the plan (\`/prp-plan\`), STOP and wait.
Your plan will be posted to the issue tracker for human review.
Do NOT proceed to implementation until you receive an approval message.
When approved, you will receive a message — then continue with \`/prp-ralph\`.`);
  }

  if (prp.gates.pr) {
    sections.push(`## PR Review Gate

IMPORTANT: After creating the PR (\`/prp-pr\`), STOP and wait.
The PR will be flagged for human review before merge.
Complete the self-review (\`/prp-review\`) but do not expect auto-merge.`);
  }

  return sections.join("\n\n");
}
