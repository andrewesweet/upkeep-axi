// Generates skills/upkeep-axi/SKILL.md from src/skill.ts as a minimal stub
// that defers to the live CLI. The command summary comes from TOP_HELP - the
// same constant the CLI prints - so the skill cannot drift from the tool.
//
//   npm run build:skill            # write the file
//   npm run build:skill -- --check # fail (exit 1) if the committed file is stale
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { format } from "prettier";

import { createSkillMarkdown } from "../src/skill.js";

const target = new URL("../skills/upkeep-axi/SKILL.md", import.meta.url);
const targetPath = fileURLToPath(target);
const expected = await format(createSkillMarkdown(), {
  filepath: targetPath,
});
const check = process.argv.includes("--check");

if (check) {
  let actual: string | null = null;
  try {
    actual = await readFile(target, "utf8");
  } catch {
    // missing file falls through to the mismatch branch below
  }
  if (actual !== expected) {
    console.error(
      "skills/upkeep-axi/SKILL.md is out of date. Run `npm run build:skill` and commit the result.",
    );
    process.exit(1);
  }
  console.log("skills/upkeep-axi/SKILL.md is up to date.");
} else {
  await mkdir(new URL("../skills/upkeep-axi/", import.meta.url), {
    recursive: true,
  });
  await writeFile(target, expected);
  console.log(`Wrote ${targetPath}`);
}
