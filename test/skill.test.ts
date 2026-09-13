import { describe, expect, it } from "vitest";
import { DESCRIPTION } from "../src/cli.js";
import {
  SKILL_NAME,
  createSkillMarkdown,
  skillCommandLines,
} from "../src/skill.js";

describe("the installable skill (AXI §7, secondary path)", () => {
  it("carries trigger-shaped frontmatter", () => {
    const markdown = createSkillMarkdown();
    expect(markdown).toMatch(/^---\nname: upkeep-axi\ndescription: >/);
    expect(markdown).toContain("user-invocable: false");
    // The description is the discovery surface: it names the tool, the
    // outcome, and the intents that should load it.
    expect(markdown).toContain("upkeep-axi CLI");
    expect(markdown).toContain("Use when");
  });

  it("derives its command list from the same TOP_HELP the CLI prints", () => {
    // The extraction reads the CLI's own help constant, so a command added
    // to TOP_HELP appears here or the build:skill check fails.
    const commands = skillCommandLines();
    expect(commands).toHaveLength(5);
    expect(commands.join("\n")).toContain("status=report the update inventory");
    const markdown = createSkillMarkdown();
    for (const line of commands) {
      const [name, summary] = line.split("=");
      expect(markdown).toContain(`- \`${name}\` - ${summary}`);
    }
  });

  it("stays a static stub: identity and pointers, no live state", () => {
    const markdown = createSkillMarkdown();
    expect(markdown).toContain(`# ${SKILL_NAME}`);
    expect(markdown).toContain(DESCRIPTION);
    // Pointers at the live CLI, including both ambient paths.
    expect(markdown).toContain("`upkeep-axi ambient`");
    expect(markdown).toContain("`upkeep-axi setup hooks`");
    // Not on npm: no npx invocation may be suggested.
    expect(markdown).not.toContain("npx");
    // No version strings, no generatedAt, no per-tool rows.
    expect(markdown).not.toMatch(/generatedAt/);
    expect(markdown).not.toMatch(/tools\[\d+\]/);
  });
});
