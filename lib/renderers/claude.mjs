// Claude Code renderer: writes one .md per cluster into
// <target>/.claude/rules/pr-feedback-<slug>.md.
// Wraps lib/skill-writer.mjs which has all the existing rendering logic.

import { writeSkills } from "../skill-writer.mjs";

export const name = "claude";
export const describe = "Claude Code rules: <target>/.claude/rules/pr-feedback-*.md (default)";

export function write(clusters, opts) {
  return writeSkills(clusters, opts);
}
