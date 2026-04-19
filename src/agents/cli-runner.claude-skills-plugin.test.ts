import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildClaudeCliSkillsPluginSpec } from "./cli-runner/claude-skills-plugin.js";
import type { SkillSnapshot } from "./skills.js";
import type { Skill } from "./skills/skill-contract.js";

async function makeTempDir(prefix: string): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function buildSkillSnapshot(filePaths: string[]): SkillSnapshot {
  return {
    prompt: "",
    skills: [],
    resolvedSkills: filePaths.map((filePath, index) => {
      return {
        name: `skill-${index + 1}`,
        description: `skill ${index + 1}`,
        filePath,
      } as unknown as Skill;
    }),
  };
}

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(async (dir) => await fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("buildClaudeCliSkillsPluginSpec", () => {
  it("keeps existing skills and skips missing ones", async () => {
    const tempDir = await makeTempDir("openclaw-claude-skills-");
    tempDirs.push(tempDir);
    const existingFile = path.join(tempDir, "first", "SKILL.md");
    await fs.mkdir(path.dirname(existingFile), { recursive: true });
    await fs.writeFile(existingFile, "# skill\n");

    const spec = await buildClaudeCliSkillsPluginSpec({
      backendId: "claude-cli-streaming",
      skillsSnapshot: buildSkillSnapshot([existingFile, path.join(tempDir, "missing", "SKILL.md")]),
    });

    expect(spec.skills).toHaveLength(1);
    expect(spec.skills[0]?.name).toBe("skill-1");
    expect(spec.skills[0]?.sourceDir).toBe(path.dirname(existingFile));
    expect(spec.signature).toMatch(/[0-9a-f]{64}/);
  });

  it("does not build specs for non-claude backends", async () => {
    const spec = await buildClaudeCliSkillsPluginSpec({
      backendId: "openai",
      skillsSnapshot: buildSkillSnapshot(["/tmp/ignored/SKILL.md"]),
    });

    expect(spec).toEqual({ skills: [] });
  });
});
