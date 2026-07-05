import { tempWorkspace } from "openclaw/plugin-sdk/temp-path";
import { describe, expect, it } from "vitest";
import {
  projectSessionMemoryFlushCandidate,
  SESSION_MEMORY_FLUSH_PROJECTION_MAX_BYTES,
  SessionMemoryFlushProjectionError,
} from "./session-memory-flush-projection.js";
import {
  buildSessionMemoryFlushOperationId,
  createSessionMemoryFlushCandidate,
} from "./session-memory-flush-store.js";

describe("projectSessionMemoryFlushCandidate", () => {
  it("appends once and reconciles duplicate and concurrent projection attempts", async () => {
    const workspace = await tempWorkspace({
      rootDir: "/tmp",
      prefix: "openclaw-session-memory-flush-",
    });
    try {
      const operationId = buildSessionMemoryFlushOperationId("main", "session-1");
      const candidate = createSessionMemoryFlushCandidate({
        kind: "append",
        content: "- Durable decision",
      });
      if (candidate.kind !== "append") {
        throw new Error("expected append candidate");
      }
      const params = {
        candidate,
        operationId,
        relativePath: "memory/2026-07-05.md",
        workspaceDir: workspace.dir,
      };
      const concurrent = await Promise.all([
        projectSessionMemoryFlushCandidate(params),
        projectSessionMemoryFlushCandidate(params),
      ]);
      expect(concurrent.toSorted()).toEqual(["appended", "reconciled"]);
      expect(await projectSessionMemoryFlushCandidate(params)).toBe("reconciled");
      const text = await workspace.store.readText("memory/2026-07-05.md");
      expect(text.match(/- Durable decision/gu)).toHaveLength(1);
    } finally {
      await workspace.cleanup();
    }
  });

  it.each([
    {
      name: "hash conflict",
      expectedCode: "marker_hash_conflict",
      render: (operationId: string) =>
        `<!-- openclaw:session-memory-flush:v1 op=${operationId} sha256=${"0".repeat(64)} -->\nother\n<!-- /openclaw:session-memory-flush:v1 op=${operationId} -->\n`,
    },
    {
      name: "partial marker",
      expectedCode: "partial_marker",
      render: (operationId: string, sha256: string) =>
        `<!-- openclaw:session-memory-flush:v1 op=${operationId} sha256=${sha256} -->\npartial\n`,
    },
  ])("fails closed on $name", async ({ expectedCode, render }) => {
    const workspace = await tempWorkspace({
      rootDir: "/tmp",
      prefix: "openclaw-session-memory-flush-conflict-",
    });
    try {
      const operationId = buildSessionMemoryFlushOperationId("main", "session-2");
      const candidate = createSessionMemoryFlushCandidate({
        kind: "append",
        content: "expected",
      });
      if (candidate.kind !== "append") {
        throw new Error("expected append candidate");
      }
      await workspace.store.writeText(
        "memory/2026-07-05.md",
        render(operationId, candidate.sha256),
      );
      let error: unknown;
      try {
        await projectSessionMemoryFlushCandidate({
          candidate,
          operationId,
          relativePath: "memory/2026-07-05.md",
          workspaceDir: workspace.dir,
        });
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(SessionMemoryFlushProjectionError);
      expect((error as SessionMemoryFlushProjectionError).code).toBe(expectedCode);
    } finally {
      await workspace.cleanup();
    }
  });

  it("rejects projection outside the canonical daily memory path", async () => {
    const candidate = createSessionMemoryFlushCandidate({
      kind: "append",
      content: "must not write",
    });
    if (candidate.kind !== "append") {
      throw new Error("expected append candidate");
    }
    await expect(
      projectSessionMemoryFlushCandidate({
        candidate,
        operationId: buildSessionMemoryFlushOperationId("main", "session-3"),
        relativePath: "MEMORY.md",
        workspaceDir: "/tmp",
      }),
    ).rejects.toThrow("memory/YYYY-MM-DD.md");
  });

  it("refuses an append that would push the memory file over its readable limit", async () => {
    const workspace = await tempWorkspace({
      rootDir: "/tmp",
      prefix: "openclaw-session-memory-flush-limit-",
    });
    try {
      const relativePath = "memory/2026-07-05.md";
      const existing = "x".repeat(SESSION_MEMORY_FLUSH_PROJECTION_MAX_BYTES - 16);
      await workspace.store.writeText(relativePath, existing);
      const candidate = createSessionMemoryFlushCandidate({
        kind: "append",
        content: "this block cannot fit",
      });
      if (candidate.kind !== "append") {
        throw new Error("expected append candidate");
      }
      await expect(
        projectSessionMemoryFlushCandidate({
          candidate,
          operationId: buildSessionMemoryFlushOperationId("main", "session-limit"),
          relativePath,
          workspaceDir: workspace.dir,
        }),
      ).rejects.toThrow("would exceed");
      const fileRoot = await workspace.store.root();
      expect((await fileRoot.stat(relativePath)).size).toBe(Buffer.byteLength(existing));
    } finally {
      await workspace.cleanup();
    }
  });
});
