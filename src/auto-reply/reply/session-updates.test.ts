import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry, SessionSkillSnapshot } from "../../config/sessions.js";

const {
  buildWorkspaceSkillSnapshotMock,
  ensureSkillsWatcherMock,
  getSkillsSnapshotVersionMock,
  shouldRefreshSnapshotForVersionMock,
  updateSessionStoreMock,
  getRemoteSkillEligibilityMock,
  resolveAgentConfigMock,
  resolveSessionAgentIdMock,
  resolveAgentIdFromSessionKeyMock,
} = vi.hoisted(() => ({
  buildWorkspaceSkillSnapshotMock: vi.fn(
    (): SessionSkillSnapshot => ({ prompt: "", skills: [], resolvedSkills: [] }),
  ),
  ensureSkillsWatcherMock: vi.fn(),
  getSkillsSnapshotVersionMock: vi.fn(() => 0),
  shouldRefreshSnapshotForVersionMock: vi.fn(() => false),
  updateSessionStoreMock: vi.fn(),
  getRemoteSkillEligibilityMock: vi.fn(() => ({
    platforms: [],
    hasBin: () => false,
    hasAnyBin: () => false,
  })),
  resolveAgentConfigMock: vi.fn(() => undefined),
  resolveSessionAgentIdMock: vi.fn(() => "writer"),
  resolveAgentIdFromSessionKeyMock: vi.fn(() => "main"),
}));

vi.mock("../../agents/agent-scope.js", () => ({
  resolveAgentConfig: resolveAgentConfigMock,
  resolveSessionAgentId: resolveSessionAgentIdMock,
}));

vi.mock("../../agents/skills.js", () => ({
  buildWorkspaceSkillSnapshot: buildWorkspaceSkillSnapshotMock,
}));

vi.mock("../../agents/skills/refresh.js", () => ({
  ensureSkillsWatcher: ensureSkillsWatcherMock,
  getSkillsSnapshotVersion: getSkillsSnapshotVersionMock,
  shouldRefreshSnapshotForVersion: shouldRefreshSnapshotForVersionMock,
}));

vi.mock("../../config/sessions.js", () => ({
  updateSessionStore: updateSessionStoreMock,
  resolveSessionFilePath: vi.fn(),
  resolveSessionFilePathOptions: vi.fn(),
}));

vi.mock("../../infra/skills-remote.js", () => ({
  getRemoteSkillEligibility: getRemoteSkillEligibilityMock,
}));

vi.mock("../../routing/session-key.js", () => ({
  normalizeAgentId: (id: string) => id,
  normalizeMainKey: (key?: string) => key ?? "main",
  resolveAgentIdFromSessionKey: resolveAgentIdFromSessionKeyMock,
}));

const { ensureSkillSnapshot, resetSkillSnapshotRuntimeForTest } =
  await import("./session-updates.js");

describe("ensureSkillSnapshot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSkillSnapshotRuntimeForTest();
    buildWorkspaceSkillSnapshotMock.mockReturnValue({ prompt: "", skills: [], resolvedSkills: [] });
    getSkillsSnapshotVersionMock.mockReturnValue(0);
    shouldRefreshSnapshotForVersionMock.mockReturnValue(false);
    getRemoteSkillEligibilityMock.mockReturnValue({
      platforms: [],
      hasBin: () => false,
      hasAnyBin: () => false,
    });
    resolveAgentConfigMock.mockReturnValue(undefined);
    resolveSessionAgentIdMock.mockReturnValue("writer");
    resolveAgentIdFromSessionKeyMock.mockReturnValue("main");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses config-aware session agent resolution for legacy session keys", async () => {
    vi.stubEnv("OPENCLAW_TEST_FAST", "0");

    await ensureSkillSnapshot({
      sessionKey: "main",
      isFirstTurnInSession: false,
      workspaceDir: "/tmp/workspace",
      cfg: {
        agents: {
          list: [{ id: "writer", default: true }],
        },
      },
    });

    expect(resolveSessionAgentIdMock).toHaveBeenCalledWith({
      sessionKey: "main",
      config: {
        agents: {
          list: [{ id: "writer", default: true }],
        },
      },
    });
    expect(buildWorkspaceSkillSnapshotMock).toHaveBeenCalledWith(
      "/tmp/workspace",
      expect.objectContaining({ agentId: "writer" }),
    );
    expect(resolveAgentIdFromSessionKeyMock).not.toHaveBeenCalled();
  });

  it("reuses a cached snapshot without persisting it again on a warm hot-store turn", async () => {
    vi.stubEnv("OPENCLAW_TEST_FAST", "0");

    const sessionKey = "agent:main:main";
    const coldBackedStore = {
      [sessionKey]: {
        sessionId: "session-1",
        updatedAt: 1,
      },
    };

    await ensureSkillSnapshot({
      sessionStore: coldBackedStore,
      sessionKey,
      storePath: "/tmp/sessions.json",
      sessionId: "session-1",
      isFirstTurnInSession: true,
      workspaceDir: "/tmp/workspace",
      cfg: {
        agents: {
          list: [{ id: "writer", default: true }],
        },
      },
    });

    const hotStoreView = {
      [sessionKey]: {
        sessionId: "session-1",
        updatedAt: 2,
      },
    };

    updateSessionStoreMock.mockClear();
    buildWorkspaceSkillSnapshotMock.mockClear();

    await ensureSkillSnapshot({
      sessionStore: hotStoreView,
      sessionKey,
      storePath: "/tmp/sessions.hot.json",
      sessionId: "session-1",
      isFirstTurnInSession: false,
      workspaceDir: "/tmp/workspace",
      cfg: {
        agents: {
          list: [{ id: "writer", default: true }],
        },
      },
    });

    expect(buildWorkspaceSkillSnapshotMock).not.toHaveBeenCalled();
    expect(updateSessionStoreMock).not.toHaveBeenCalled();
  });

  it("reuses a workspace snapshot across hot-store sessions without disk writes", async () => {
    vi.stubEnv("OPENCLAW_TEST_FAST", "0");

    const snapshot = {
      prompt: "rendered skills",
      skills: [{ name: "inspect" }],
      resolvedSkills: [],
      version: 7,
    };
    buildWorkspaceSkillSnapshotMock.mockReturnValue(snapshot);
    getSkillsSnapshotVersionMock.mockReturnValue(7);

    await ensureSkillSnapshot({
      sessionStore: {
        "agent:main:one": {
          sessionId: "session-1",
          updatedAt: 1,
        },
      },
      sessionKey: "agent:main:one",
      storePath: "/tmp/sessions.hot.json",
      sessionId: "session-1",
      isFirstTurnInSession: false,
      workspaceDir: "/tmp/workspace",
      cfg: {
        agents: {
          list: [{ id: "writer", default: true }],
        },
      },
    });

    updateSessionStoreMock.mockClear();

    const secondHotStore: Record<string, SessionEntry> = {
      "agent:main:two": {
        sessionId: "session-2",
        updatedAt: 2,
      },
    };

    const result = await ensureSkillSnapshot({
      sessionStore: secondHotStore,
      sessionKey: "agent:main:two",
      storePath: "/tmp/sessions.hot.json",
      sessionId: "session-2",
      isFirstTurnInSession: false,
      workspaceDir: "/tmp/workspace",
      cfg: {
        agents: {
          list: [{ id: "writer", default: true }],
        },
      },
    });

    expect(buildWorkspaceSkillSnapshotMock).toHaveBeenCalledTimes(1);
    expect(updateSessionStoreMock).not.toHaveBeenCalled();
    expect(result.skillsSnapshot).toBe(snapshot);
    expect(secondHotStore["agent:main:two"]?.skillsSnapshot).toBe(snapshot);
  });

  it("persists refreshed metadata when an existing entry snapshot is stale", async () => {
    vi.stubEnv("OPENCLAW_TEST_FAST", "0");

    shouldRefreshSnapshotForVersionMock.mockImplementation((cached?: number, next?: number) => {
      const cachedVersion = typeof cached === "number" ? cached : 0;
      const nextVersion = typeof next === "number" ? next : 0;
      return nextVersion === 0 ? cachedVersion > 0 : cachedVersion < nextVersion;
    });
    getSkillsSnapshotVersionMock.mockReturnValue(2);
    buildWorkspaceSkillSnapshotMock.mockReturnValue({
      prompt: "new skills",
      skills: [{ name: "inspect" }],
      resolvedSkills: [],
      version: 2,
    });

    const sessionKey = "agent:main:main";
    const entry = {
      sessionId: "session-1",
      updatedAt: 1,
      skillsSnapshot: {
        prompt: "old skills",
        skills: [{ name: "inspect" }],
        resolvedSkills: [],
        version: 1,
      },
    };

    await ensureSkillSnapshot({
      sessionEntry: entry,
      sessionStore: { [sessionKey]: entry },
      sessionKey,
      storePath: "/tmp/sessions.json",
      sessionId: "session-1",
      isFirstTurnInSession: false,
      workspaceDir: "/tmp/workspace",
      cfg: {
        agents: {
          list: [{ id: "writer", default: true }],
        },
      },
    });

    expect(buildWorkspaceSkillSnapshotMock).toHaveBeenCalledTimes(1);
    expect(updateSessionStoreMock).toHaveBeenCalledTimes(1);
    expect(updateSessionStoreMock).toHaveBeenCalledWith("/tmp/sessions.json", expect.any(Function));
  });
});
