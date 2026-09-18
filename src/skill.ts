import { DESCRIPTION, TOP_HELP } from "./cli.js";
import { reportOnlySurfaces, SURFACE_REGISTRY } from "./surfaces/index.js";

/**
 * The installable skill (AXI §7's secondary path): a minimal static stub
 * whose frontmatter is the discovery surface and whose body only names what
 * upkeep-axi is, when to reach for it, and pointers at the live CLI. Live
 * inventory never belongs here - the session-start hook (`setup hooks`)
 * carries state; the skill carries none.
 *
 * The command summary is extracted from TOP_HELP - the same constant the
 * CLI prints - so the skill cannot drift from the tool's own words; CI
 * runs `npm run build:skill -- --check` to fail a stale committed file.
 */

export const SKILL_NAME = "upkeep-axi";

export const SKILL_DESCRIPTION =
  "Report this workstation's update inventory via the upkeep-axi CLI - installed vs available " +
  `versions per surface (${SURFACE_REGISTRY.map((surface) => surface.id).join(", ")}), ` +
  "the semver tier of each gap, whether the tool " +
  "is in use, PATH skew, and the exact apply and pin commands. Use when the user asks what is " +
  "outdated, before updating or pinning workstation tools, when checking whether an update took " +
  "effect, or before applying updates with upkeep-axi apply.";

/** The `name=summary` lines of the commands block, verbatim from TOP_HELP. */
export function skillCommandLines(topHelp: string = TOP_HELP): string[] {
  const lines = topHelp.split("\n");
  const start = lines.findIndex((line) => /^commands\[\d+\]:$/.test(line));
  if (start === -1) {
    throw new Error("TOP_HELP lost its commands block; fix src/skill.ts");
  }
  const commands: string[] = [];
  for (let index = start + 1; index < lines.length; index++) {
    const line = lines[index];
    if (!line.startsWith("  ")) break;
    commands.push(line.trim());
  }
  if (commands.length === 0) {
    throw new Error("TOP_HELP commands block is empty; fix src/skill.ts");
  }
  return commands;
}

/**
 * Render the installable SKILL.md. The body stays minimal: identity, the
 * command summary shared with TOP_HELP, and pointers to the live CLI -
 * never output schema, field semantics, or state.
 *
 * @returns full SKILL.md contents including YAML frontmatter
 */
export function createSkillMarkdown(): string {
  const commandLines = skillCommandLines()
    .map((line) => {
      const [name, ...rest] = line.split("=");
      return `- \`${name}\` - ${rest.join("=")}`;
    })
    .join("\n");
  const reportOnly = reportOnlySurfaces()
    .map((surface) => surface.id)
    .join(", ");
  return `---
name: ${SKILL_NAME}
description: >
  ${SKILL_DESCRIPTION}
user-invocable: false
---

# ${SKILL_NAME}

${DESCRIPTION} Read-only \`status\` reports installed vs available versions,
the semver tier of each gap, in-use conflicts, PATH skew, and the exact
commands that apply or pin each tool. \`apply\` plans by default and runs a
vendor's own updater only with \`--execute\`; every run is journaled. The tool
never runs as root, and report-only surfaces (${reportOnly}) are never applied.

Commands (kept identical to the CLI's own top-level help):

${commandLines}

For the live inventory and current flags, run the CLI from its source
checkout on this host (it is not published to npm):

- \`upkeep-axi\` - the full inventory (TOON; add \`--json\` for the model)
- \`upkeep-axi status --help\` - status flags, including drift filters
- \`upkeep-axi ambient\` - the bounded dashboard (known gaps only, in-use gaps first)
- \`upkeep-axi setup hooks\` - install the session-start hook that injects that
  dashboard at every agent session start (the hook is the primary, ambient
  path; this skill is the secondary, on-demand one - either alone suffices)
`;
}
