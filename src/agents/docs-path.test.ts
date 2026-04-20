import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { makeTempWorkspace } from "../test-helpers/workspace.js";
import { clearOpenClawDocsPathCacheForTest, resolveOpenClawDocsPath } from "./docs-path.js";

describe("resolveOpenClawDocsPath", () => {
  it("memoizes repeated lookups for the same workspace inputs", async () => {
    clearOpenClawDocsPathCacheForTest();
    const tempDir = await makeTempWorkspace("openclaw-docs-");
    const docsDir = path.join(tempDir, "docs");
    await fs.promises.mkdir(docsDir, { recursive: true });

    const existsSpy = vi.spyOn(fs, "existsSync");
    try {
      const first = await resolveOpenClawDocsPath({ workspaceDir: tempDir });
      const second = await resolveOpenClawDocsPath({ workspaceDir: tempDir });

      expect(first).toBe(docsDir);
      expect(second).toBe(docsDir);
      expect(existsSpy).toHaveBeenCalledTimes(1);
    } finally {
      existsSpy.mockRestore();
      clearOpenClawDocsPathCacheForTest();
    }
  });
});
