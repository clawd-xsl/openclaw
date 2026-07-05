import { mkdir, rename } from "node:fs/promises";
import path from "node:path";
import { tempWorkspace } from "openclaw/plugin-sdk/temp-path";
import { describe, expect, it } from "vitest";
import {
  projectSessionMemoryFlushCandidate,
  SESSION_MEMORY_FLUSH_PROJECTION_MAX_BYTES,
  SessionMemoryFlushProjectionError,
  withSessionMemoryFlushProjectionLock,
} from "./session-memory-flush-projection.js";
import {
  buildSessionMemoryFlushOperationId,
  createSessionMemoryFlushCandidate,
} from "./session-memory-flush-store.js";

function projectionTarget(workspaceDir: string) {
  return {
    lockDir: `${workspaceDir}/.openclaw/projection-locks`,
    workspaceDir,
    workspaceFingerprint: "a".repeat(64),
  };
}

describe("projectSessionMemoryFlushCandidate", () => {
  it("serializes process-local projection lock holders", async () => {
    const workspace = await tempWorkspace({
      rootDir: "/tmp",
      prefix: "openclaw-session-memory-flush-process-lock-",
    });
    let releaseFirst: (() => void) | undefined;
    const firstReleased = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let markFirstEntered: (() => void) | undefined;
    const firstEntered = new Promise<void>((resolve) => {
      markFirstEntered = resolve;
    });
    let secondEntered = false;
    const target = {
      ...projectionTarget(workspace.dir),
      relativePath: "memory/2026-07-05.md",
    };
    try {
      const first = withSessionMemoryFlushProjectionLock(target, async () => {
        markFirstEntered?.();
        await firstReleased;
      });
      await firstEntered;
      const second = withSessionMemoryFlushProjectionLock(target, async () => {
        secondEntered = true;
      });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(secondEntered).toBe(false);

      releaseFirst?.();
      await Promise.all([first, second]);
      expect(secondEntered).toBe(true);
    } finally {
      releaseFirst?.();
      await workspace.cleanup();
    }
  });

  it("keeps the same stable lock when the workspace path is replaced", async () => {
    const rootWorkspace = await tempWorkspace({
      rootDir: "/tmp",
      prefix: "openclaw-session-memory-flush-stable-lock-",
    });
    const workspaceDir = path.join(rootWorkspace.dir, "workspace");
    const target = {
      lockDir: path.join(rootWorkspace.dir, "state", "projection-locks"),
      relativePath: "memory/2026-07-05.md",
      workspaceDir,
      workspaceFingerprint: "b".repeat(64),
    };
    let releaseFirst: (() => void) | undefined;
    const firstReleased = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let markFirstEntered: (() => void) | undefined;
    const firstEntered = new Promise<void>((resolve) => {
      markFirstEntered = resolve;
    });
    try {
      await mkdir(workspaceDir);
      const first = withSessionMemoryFlushProjectionLock(target, async () => {
        markFirstEntered?.();
        await firstReleased;
      });
      await firstEntered;
      await rename(workspaceDir, `${workspaceDir}-old`);
      await mkdir(workspaceDir);
      let secondEntered = false;
      const second = withSessionMemoryFlushProjectionLock(target, async () => {
        secondEntered = true;
      });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(secondEntered).toBe(false);

      releaseFirst?.();
      await Promise.all([first, second]);
      expect(secondEntered).toBe(true);
    } finally {
      releaseFirst?.();
      await rootWorkspace.cleanup();
    }
  });

  it("allows purge locking after the old workspace has disappeared", async () => {
    const stateWorkspace = await tempWorkspace({
      rootDir: "/tmp",
      prefix: "openclaw-session-memory-flush-missing-workspace-",
    });
    try {
      let purged = false;
      await withSessionMemoryFlushProjectionLock(
        {
          lockDir: path.join(stateWorkspace.dir, "projection-locks"),
          relativePath: "memory/2026-07-05.md",
          workspaceDir: path.join(stateWorkspace.dir, "deleted-workspace"),
          workspaceFingerprint: "c".repeat(64),
        },
        async () => {
          purged = true;
        },
      );
      expect(purged).toBe(true);
    } finally {
      await stateWorkspace.cleanup();
    }
  });

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
        ...projectionTarget(workspace.dir),
        operationId,
        relativePath: "memory/2026-07-05.md",
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
          ...projectionTarget(workspace.dir),
          operationId,
          relativePath: "memory/2026-07-05.md",
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
        ...projectionTarget("/tmp"),
        operationId: buildSessionMemoryFlushOperationId("main", "session-3"),
        relativePath: "MEMORY.md",
      }),
    ).rejects.toThrow("memory/YYYY-MM-DD.md");
  });

  it("checks cancellation under the target lock before creating the memory file", async () => {
    const workspace = await tempWorkspace({
      rootDir: "/tmp",
      prefix: "openclaw-session-memory-flush-cancelled-",
    });
    try {
      const candidate = createSessionMemoryFlushCandidate({
        kind: "append",
        content: "must not be projected",
      });
      if (candidate.kind !== "append") {
        throw new Error("expected append candidate");
      }
      await expect(
        projectSessionMemoryFlushCandidate({
          candidate,
          ...projectionTarget(workspace.dir),
          operationId: buildSessionMemoryFlushOperationId("main", "session-cancelled"),
          relativePath: "memory/2026-07-05.md",
          shouldProject: () => false,
        }),
      ).resolves.toBe("cancelled");
      await expect(workspace.store.readText("memory/2026-07-05.md")).rejects.toThrow();
    } finally {
      await workspace.cleanup();
    }
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
          ...projectionTarget(workspace.dir),
          operationId: buildSessionMemoryFlushOperationId("main", "session-limit"),
          relativePath,
        }),
      ).rejects.toThrow("would exceed");
      const fileRoot = await workspace.store.root();
      expect((await fileRoot.stat(relativePath)).size).toBe(Buffer.byteLength(existing));
    } finally {
      await workspace.cleanup();
    }
  });
});
