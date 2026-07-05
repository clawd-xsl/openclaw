// Qqbot tests cover activation plugin behavior.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { clearSessionStoreCacheForTest } from "openclaw/plugin-sdk/session-store-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createNodeSessionStoreReader,
  resolveGroupActivation,
  type SessionStoreReader,
} from "./activation.js";

const tempDirs: string[] = [];

afterEach(() => {
  clearSessionStoreCacheForTest();
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("engine/group/activation", () => {
  describe("resolveGroupActivation — no reader", () => {
    it("maps configRequireMention=true → mention", () => {
      expect(
        resolveGroupActivation({
          cfg: {},
          agentId: "main",
          sessionKey: "s",
          configRequireMention: true,
        }),
      ).toBe("mention");
    });

    it("maps configRequireMention=false → always", () => {
      expect(
        resolveGroupActivation({
          cfg: {},
          agentId: "main",
          sessionKey: "s",
          configRequireMention: false,
        }),
      ).toBe("always");
    });
  });

  describe("resolveGroupActivation — with reader", () => {
    const makeReader = (entry: { groupActivation?: string } | null): SessionStoreReader => ({
      read: () => entry,
    });

    it("honours explicit session-store override (mention)", () => {
      const reader = makeReader({ groupActivation: "mention" });
      expect(
        resolveGroupActivation({
          cfg: {},
          agentId: "main",
          sessionKey: "k1",
          configRequireMention: false,
          sessionStoreReader: reader,
        }),
      ).toBe("mention");
    });

    it("honours explicit session-store override (always)", () => {
      const reader = makeReader({ groupActivation: "always" });
      expect(
        resolveGroupActivation({
          cfg: {},
          agentId: "main",
          sessionKey: "k1",
          configRequireMention: true,
          sessionStoreReader: reader,
        }),
      ).toBe("always");
    });

    it("ignores override when the key is absent", () => {
      const reader = makeReader(null);
      expect(
        resolveGroupActivation({
          cfg: {},
          agentId: "main",
          sessionKey: "MISSING",
          configRequireMention: true,
          sessionStoreReader: reader,
        }),
      ).toBe("mention");
    });

    it("ignores reader errors (null) and falls back", () => {
      const reader = makeReader(null);
      expect(
        resolveGroupActivation({
          cfg: {},
          agentId: "main",
          sessionKey: "k1",
          configRequireMention: false,
          sessionStoreReader: reader,
        }),
      ).toBe("always");
    });

    it("ignores invalid activation values", () => {
      const reader = makeReader({ groupActivation: "weird-mode" });
      expect(
        resolveGroupActivation({
          cfg: {},
          agentId: "main",
          sessionKey: "k1",
          configRequireMention: true,
          sessionStoreReader: reader,
        }),
      ).toBe("mention");
    });

    it("normalizes whitespace / case", () => {
      const reader = makeReader({ groupActivation: "  Always  " });
      expect(
        resolveGroupActivation({
          cfg: {},
          agentId: "main",
          sessionKey: "k1",
          configRequireMention: true,
          sessionStoreReader: reader,
        }),
      ).toBe("always");
    });
  });

  it("reads activation from the default SQLite-backed session store", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-qqbot-activation-"));
    tempDirs.push(stateDir);
    const sessionsDir = path.join(stateDir, "agents", "bot", "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionsDir, "sessions.json"),
      JSON.stringify({ room: { sessionId: "room", groupActivation: "always" } }),
    );
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateDir;
    try {
      expect(
        createNodeSessionStoreReader().read({
          cfg: {},
          agentId: "bot",
          sessionKey: "room",
        })?.groupActivation,
      ).toBe("always");
      expect(fs.existsSync(path.join(sessionsDir, "sessions.sqlite"))).toBe(true);
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
    }
  });

  it("uses the keyed session accessor for the requested group", () => {
    const getSessionEntry = vi.fn(() => ({
      sessionId: "room",
      updatedAt: 1,
      groupActivation: "always" as const,
    }));
    const reader = createNodeSessionStoreReader({ getSessionEntry });

    expect(
      reader.read({
        cfg: {},
        agentId: "bot",
        sessionKey: "agent:bot:qqbot:group:room",
      })?.groupActivation,
    ).toBe("always");
    expect(getSessionEntry).toHaveBeenCalledOnce();
    expect(getSessionEntry).toHaveBeenCalledWith({
      agentId: "bot",
      hydrateSkillPromptRefs: false,
      sessionKey: "agent:bot:qqbot:group:room",
      storePath: expect.stringContaining(path.join("agents", "bot", "sessions", "sessions.sqlite")),
    });
  });
});
