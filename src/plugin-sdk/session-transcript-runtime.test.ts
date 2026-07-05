import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendTranscriptEvent, upsertSessionEntry } from "../config/sessions/session-accessor.js";
import { loadSessionStore } from "../config/sessions/store.js";
import { withOwnedSessionTranscriptWrites } from "../config/sessions/transcript-write-context.js";
import * as transcriptEvents from "../sessions/transcript-events.js";
import {
  appendAssistantMirrorMessageByIdentity,
  appendSessionTranscriptMessageByIdentity,
  formatSessionTranscriptMemoryHitKey,
  parseSessionTranscriptMemoryHitKey,
  publishSessionTranscriptUpdateByIdentity,
  readBoundedSessionTranscriptEvents,
  readLatestAssistantTextByIdentity,
  readSessionTranscriptEvents,
  resolveSessionTranscriptIdentity,
  sanitizeSessionTranscriptMessageText,
  resolveSessionTranscriptLegacyFileTarget,
  resolveSessionTranscriptTarget,
  resolveSessionTranscriptMemoryHitKeyToSessionKeys,
  withSessionTranscriptWriteLock,
} from "./session-transcript-runtime.js";

describe("session transcript runtime SDK", () => {
  it("strips model-facing inbound metadata only from persisted user text", () => {
    const text = [
      "Conversation info (untrusted metadata):",
      "```json",
      '{"message_id":"123","sender":"operator"}',
      "```",
      "",
      "Continue the migration.",
    ].join("\n");

    expect(sanitizeSessionTranscriptMessageText({ role: "user", text })).toBe(
      "Continue the migration.",
    );
    expect(sanitizeSessionTranscriptMessageText({ role: "assistant", text })).toBe(text);
  });

  let tempDir: string;
  let storePath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sdk-transcript-"));
    storePath = path.join(tempDir, "sessions.json");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tempDir, { force: true, recursive: true });
  });

  it("resolves transcript identity and reads events without returning sessionFile", async () => {
    const scope = {
      agentId: "Main",
      sessionId: "session-with-colon",
      sessionKey: "agent:main:main",
      storePath,
    };
    const event = { id: "event-1", type: "metadata" };

    await upsertSessionEntry(scope, { sessionId: scope.sessionId, updatedAt: 10 });
    await appendTranscriptEvent(scope, event);

    const identity = await resolveSessionTranscriptIdentity(scope);

    expect(identity).toEqual({
      agentId: "main",
      memoryKey: "transcript:main:session-with-colon",
      sessionId: scope.sessionId,
      sessionKey: "agent:main:main",
    });
    expect(identity).not.toHaveProperty("sessionFile");
    await expect(readSessionTranscriptEvents(scope)).resolves.toEqual([event]);
  });

  it("does not persist sessionFile metadata for identity-only reads", async () => {
    const scope = {
      agentId: "main",
      sessionId: "read-only-session",
      sessionKey: "agent:main:main",
      storePath,
    };

    await upsertSessionEntry(scope, { sessionId: scope.sessionId, updatedAt: 10 });

    await expect(resolveSessionTranscriptIdentity(scope)).resolves.toMatchObject({
      memoryKey: "transcript:main:read-only-session",
    });
    await expect(readSessionTranscriptEvents(scope)).resolves.toEqual([]);
    expect(loadSessionStore(storePath)[scope.sessionKey]?.sessionFile).toBeUndefined();
  });

  it("persists and returns a file target for legacy command callers", async () => {
    const scope = {
      agentId: "main",
      sessionId: "legacy-command-session",
      sessionKey: "agent:main:main",
      storePath,
    };

    await upsertSessionEntry(scope, { sessionId: scope.sessionId, updatedAt: 10 });

    const target = await resolveSessionTranscriptLegacyFileTarget(scope);

    expect(target).toMatchObject({
      agentId: "main",
      memoryKey: "transcript:main:legacy-command-session",
      sessionId: "legacy-command-session",
      sessionKey: "agent:main:main",
      targetKind: "runtime-session",
    });
    expect(target.sessionFile).toContain("legacy-command-session");
    expect(loadSessionStore(storePath)[scope.sessionKey]?.sessionFile).toBe(target.sessionFile);
  });

  it("appends assistant mirrors through the guarded session facade", async () => {
    const scope = {
      agentId: "main",
      sessionId: "guarded-mirror-session",
      sessionKey: "agent:main:main",
      storePath,
    };

    await upsertSessionEntry(scope, { sessionId: scope.sessionId, updatedAt: 10 });

    await expect(
      appendAssistantMirrorMessageByIdentity({
        ...scope,
        deliveryMirror: { kind: "channel-final", sourceMessageId: "delivery-1" },
        idempotencyKey: "delivery-1",
        text: "visible assistant reply",
      }),
    ).resolves.toMatchObject({ ok: true, messageId: expect.any(String) });
    await expect(
      appendAssistantMirrorMessageByIdentity({
        ...scope,
        deliveryMirror: { kind: "channel-final", sourceMessageId: "delivery-2" },
        idempotencyKey: "delivery-2",
        text: "visible assistant reply",
      }),
    ).resolves.toMatchObject({ ok: true, messageId: expect.any(String) });
    await expect(readLatestAssistantTextByIdentity(scope)).resolves.toBeUndefined();
    const assistantMessages = (await readSessionTranscriptEvents(scope)).filter((event) => {
      const message = (event as { message?: { role?: unknown } }).message;
      return message?.role === "assistant";
    });
    expect(assistantMessages).toHaveLength(2);

    await upsertSessionEntry(scope, { sessionId: "new-session", updatedAt: 20 });

    await expect(
      appendAssistantMirrorMessageByIdentity({
        ...scope,
        text: "stale assistant reply",
      }),
    ).resolves.toMatchObject({ ok: false, code: "session-rebound" });
  });

  it("skips malformed transcript lines when reading by scoped identity", async () => {
    const scope = {
      agentId: "main",
      sessionFile: path.join(tempDir, "malformed-lines.jsonl"),
      sessionId: "malformed-session",
      sessionKey: "agent:main:main",
      storePath,
    };
    const firstEvent = { id: "event-valid-1", type: "message" };
    const secondEvent = { id: "event-valid-2", type: "message" };

    fs.writeFileSync(
      scope.sessionFile,
      [
        JSON.stringify(firstEvent),
        "{malformed-json",
        JSON.stringify(secondEvent),
        "not-json",
        "",
      ].join("\n"),
      "utf8",
    );

    await expect(readSessionTranscriptEvents(scope)).resolves.toEqual([firstEvent, secondEvent]);
  });

  it("reads bounded transcript head and tail windows without retaining the middle", async () => {
    const scope = {
      agentId: "main",
      sessionFile: path.join(tempDir, "bounded-session.jsonl"),
      sessionId: "bounded-session",
      sessionKey: "agent:main:main",
      storePath,
    };
    const events = Array.from({ length: 12 }, (_, index) => ({
      id: `event-${index}`,
      padding: "x".repeat(96),
      type: "message",
    }));
    fs.writeFileSync(
      scope.sessionFile,
      `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    );

    await expect(
      readBoundedSessionTranscriptEvents({ ...scope, maxBytes: 900, maxEvents: 5 }),
    ).resolves.toEqual({
      available: true,
      events: [events[0], ...events.slice(-4)],
      truncated: true,
    });
  });

  it("keeps the first event when the oversized head window contains many events", async () => {
    const scope = {
      agentId: "main",
      sessionFile: path.join(tempDir, "bounded-small-events.jsonl"),
      sessionId: "bounded-small-events",
      sessionKey: "agent:main:main",
      storePath,
    };
    const events = Array.from({ length: 100 }, (_, index) => ({ id: index }));
    fs.writeFileSync(
      scope.sessionFile,
      `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    );

    await expect(
      readBoundedSessionTranscriptEvents({ ...scope, maxBytes: 250, maxEvents: 5 }),
    ).resolves.toEqual({
      available: true,
      events: [events[0], ...events.slice(-4)],
      truncated: true,
    });
  });

  it("bounds event count even when the transcript fits the byte budget", async () => {
    const scope = {
      agentId: "main",
      sessionFile: path.join(tempDir, "bounded-event-count.jsonl"),
      sessionId: "bounded-event-count",
      sessionKey: "agent:main:main",
      storePath,
    };
    const events = Array.from({ length: 8 }, (_, index) => ({ id: `event-${index}` }));
    fs.writeFileSync(
      scope.sessionFile,
      `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    );

    await expect(
      readBoundedSessionTranscriptEvents({ ...scope, maxBytes: 8_192, maxEvents: 5 }),
    ).resolves.toEqual({
      available: true,
      events: [events[0], ...events.slice(-4)],
      truncated: true,
    });
  });

  it("retains only head and tail events from a small-byte transcript with many events", async () => {
    const scope = {
      agentId: "main",
      sessionFile: path.join(tempDir, "bounded-many-events.jsonl"),
      sessionId: "bounded-many-events",
      sessionKey: "agent:main:main",
      storePath,
    };
    const events = Array.from({ length: 5_000 }, (_, index) => ({ id: index }));
    const serialized = `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
    fs.writeFileSync(scope.sessionFile, serialized);

    await expect(
      readBoundedSessionTranscriptEvents({
        ...scope,
        maxBytes: Buffer.byteLength(serialized),
        maxEvents: 5,
      }),
    ).resolves.toEqual({
      available: true,
      events: [events[0], ...events.slice(-4)],
      truncated: true,
    });
  });

  it("pins the file-size snapshot when the transcript grows during a bounded read", async () => {
    const scope = {
      agentId: "main",
      sessionFile: path.join(tempDir, "bounded-growing.jsonl"),
      sessionId: "bounded-growing",
      sessionKey: "agent:main:main",
      storePath,
    };
    const first = { id: "before-snapshot" };
    const appended = { id: "after-snapshot" };
    const initial = Buffer.from(`${JSON.stringify(first)}\n`, "utf8");
    const grown = Buffer.from(`${JSON.stringify(first)}\n${JSON.stringify(appended)}\n`, "utf8");
    const read = vi.fn(async (buffer: Buffer, offset: number, length: number, position: number) => {
      const bytesRead = grown.copy(buffer, offset, position, position + length);
      return { buffer, bytesRead };
    });
    vi.spyOn(fs.promises, "open").mockResolvedValue({
      close: vi.fn(async () => undefined),
      read,
      stat: vi.fn(async () => ({ isFile: () => true, size: initial.length })),
    } as never);

    await expect(
      readBoundedSessionTranscriptEvents({ ...scope, maxBytes: 4_096, maxEvents: 5 }),
    ).resolves.toEqual({ available: true, events: [first], truncated: false });
    expect(read).toHaveBeenCalledWith(expect.any(Buffer), 0, initial.length, 0);
  });

  it("distinguishes an unavailable transcript from an available empty transcript", async () => {
    const scope = {
      agentId: "main",
      sessionId: "availability",
      sessionKey: "agent:main:main",
      storePath,
    };
    await expect(
      readBoundedSessionTranscriptEvents({ ...scope, maxBytes: 512, maxEvents: 5 }),
    ).resolves.toEqual({ available: false, events: [], truncated: false });

    const sessionFile = path.join(tempDir, "available-empty.jsonl");
    fs.writeFileSync(sessionFile, "");
    await expect(
      readBoundedSessionTranscriptEvents({
        ...scope,
        sessionFile,
        maxBytes: 512,
        maxEvents: 5,
      }),
    ).resolves.toEqual({ available: true, events: [], truncated: false });
  });

  it("binds scoped reads to an explicit active transcript file without exposing it", async () => {
    const scope = {
      agentId: "main",
      sessionFile: path.join(tempDir, "active-session.jsonl"),
      sessionId: "active-session",
      sessionKey: "agent:main:main",
      storePath,
    };
    const event = { id: "event-active", type: "metadata" };

    await upsertSessionEntry(scope, {
      sessionFile: path.join(tempDir, "store-default.jsonl"),
      sessionId: scope.sessionId,
      updatedAt: 10,
    });
    await appendTranscriptEvent(scope, event);

    const target = await resolveSessionTranscriptTarget(scope);

    expect(target).toEqual({
      agentId: "main",
      memoryKey: "transcript:main:active-session",
      sessionId: "active-session",
      sessionKey: "agent:main:main",
      targetKind: "active-session-file",
    });
    expect(target).not.toHaveProperty("sessionFile");
    await expect(readSessionTranscriptEvents(scope)).resolves.toEqual([event]);
    expect(fs.readFileSync(scope.sessionFile, "utf8")).toContain("event-active");
  });

  it("appends messages by the same explicit scoped transcript target", async () => {
    const scope = {
      agentId: "main",
      sessionFile: path.join(tempDir, "mirror-target.jsonl"),
      sessionId: "mirror-session",
      sessionKey: "agent:main:main",
      storePath,
    };
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "hello" }],
      timestamp: 1,
    };

    const appended = await appendSessionTranscriptMessageByIdentity({
      ...scope,
      message,
    });

    expect(appended).toBeDefined();
    expect(appended?.message).toMatchObject(message);
    await expect(readLatestAssistantTextByIdentity(scope)).resolves.toMatchObject({
      text: "hello",
      timestamp: 1,
    });
    await expect(readSessionTranscriptEvents(scope)).resolves.toEqual([
      expect.objectContaining({ type: "session" }),
      expect.objectContaining({ message: expect.objectContaining({ role: "assistant" }) }),
    ]);
  });

  it("publishes updates with the resolved scoped transcript identity", async () => {
    const scope = {
      agentId: "main",
      sessionFile: path.join(tempDir, "publish-target.jsonl"),
      sessionId: "publish-session",
      sessionKey: "agent:main:main",
      storePath,
    };
    const emitSpy = vi.spyOn(transcriptEvents, "emitSessionTranscriptUpdate");

    await publishSessionTranscriptUpdateByIdentity({
      ...scope,
      update: {
        agentId: "stale-agent",
        messageId: "message-from-direct-publish",
        sessionKey: "agent:stale:other",
      },
    });

    expect(emitSpy).toHaveBeenCalledWith({
      agentId: "main",
      messageId: "message-from-direct-publish",
      sessionFile: scope.sessionFile,
      sessionKey: "agent:main:main",
      target: {
        agentId: "main",
        sessionId: "publish-session",
        sessionKey: "agent:main:main",
      },
    });
  });

  it("locks read and append helpers to one scoped transcript target", async () => {
    const scope = {
      agentId: "main",
      sessionFile: path.join(tempDir, "locked-target.jsonl"),
      sessionId: "locked-session",
      sessionKey: "agent:main:main",
      storePath,
    };

    const target = await withSessionTranscriptWriteLock(scope, async (locked) => {
      expect(await locked.readEvents()).toEqual([]);
      await locked.appendMessage({
        message: {
          role: "assistant",
          content: [{ type: "text", text: "locked" }],
          timestamp: 1,
        },
      });
      return locked.target;
    });

    expect(target).toMatchObject({
      sessionId: "locked-session",
      targetKind: "active-session-file",
    });
    expect(target).not.toHaveProperty("sessionFile");
    await expect(readSessionTranscriptEvents(scope)).resolves.toEqual([
      expect.objectContaining({ type: "session" }),
      expect.objectContaining({ message: expect.objectContaining({ role: "assistant" }) }),
    ]);
  });

  it("uses the owned active transcript write context for scoped locked appends", async () => {
    const scope = {
      agentId: "main",
      sessionFile: path.join(tempDir, "owned-active-target.jsonl"),
      sessionId: "owned-active-session",
      sessionKey: "agent:main:main",
      storePath,
    };
    const storeDefaultFile = path.join(tempDir, "store-default-owned.jsonl");
    const lockEvents: string[] = [];

    await upsertSessionEntry(scope, {
      sessionFile: storeDefaultFile,
      sessionId: scope.sessionId,
      updatedAt: 10,
    });

    const target = await withOwnedSessionTranscriptWrites(
      {
        sessionFile: scope.sessionFile,
        sessionKey: scope.sessionKey,
        withSessionWriteLock: async (run) => {
          lockEvents.push("lock");
          return await run();
        },
      },
      async () =>
        await withSessionTranscriptWriteLock(scope, async (locked) => {
          await locked.appendMessage({
            message: {
              role: "assistant",
              content: [{ type: "text", text: "owned locked" }],
              timestamp: 1,
            },
          });
          return locked.target;
        }),
    );

    expect(lockEvents).toEqual(["lock"]);
    expect(target).toMatchObject({
      sessionId: "owned-active-session",
      targetKind: "active-session-file",
    });
    expect(fs.readFileSync(scope.sessionFile, "utf8")).toContain("owned locked");
    expect(fs.existsSync(storeDefaultFile)).toBe(false);
    await expect(readSessionTranscriptEvents(scope)).resolves.toEqual([
      expect.objectContaining({ type: "session" }),
      expect.objectContaining({ message: expect.objectContaining({ role: "assistant" }) }),
    ]);
  });

  it("publishes queued locked updates after callback appends are visible", async () => {
    const scope = {
      agentId: "main",
      sessionFile: path.join(tempDir, "queued-publish-target.jsonl"),
      sessionId: "queued-publish-session",
      sessionKey: "agent:main:main",
      storePath,
    };
    const observedUpdates: Array<{
      callbackCompleted: boolean;
      fileText: string;
      update: unknown;
    }> = [];
    let callbackCompleted = false;
    const emitSpy = vi
      .spyOn(transcriptEvents, "emitSessionTranscriptUpdate")
      .mockImplementation((update) => {
        observedUpdates.push({
          callbackCompleted,
          fileText: fs.readFileSync(scope.sessionFile, "utf8"),
          update,
        });
      });

    const result = await withSessionTranscriptWriteLock(scope, async (locked) => {
      await locked.appendMessage({
        message: {
          role: "assistant",
          content: [{ type: "text", text: "queued publish" }],
          timestamp: 1,
        },
      });
      await locked.publishUpdate({
        messageId: "message-from-callback",
      });
      expect(emitSpy).not.toHaveBeenCalled();
      callbackCompleted = true;
      return "complete";
    });

    expect(result).toBe("complete");
    expect(emitSpy).toHaveBeenCalledTimes(1);
    expect(observedUpdates).toEqual([
      {
        callbackCompleted: true,
        fileText: expect.stringContaining("queued publish"),
        update: expect.objectContaining({
          messageId: "message-from-callback",
          agentId: "main",
          sessionFile: scope.sessionFile,
          sessionKey: scope.sessionKey,
        }),
      },
    ]);
  });

  it("does not publish queued locked updates when the callback throws", async () => {
    const scope = {
      agentId: "main",
      sessionFile: path.join(tempDir, "failed-queued-publish-target.jsonl"),
      sessionId: "failed-queued-publish-session",
      sessionKey: "agent:main:main",
      storePath,
    };
    const emitSpy = vi.spyOn(transcriptEvents, "emitSessionTranscriptUpdate");

    await expect(
      withSessionTranscriptWriteLock(scope, async (locked) => {
        await locked.appendMessage({
          message: {
            role: "assistant",
            content: [{ type: "text", text: "durable but failed" }],
            timestamp: 1,
          },
        });
        await locked.publishUpdate({ sessionKey: scope.sessionKey });
        throw new Error("stop before commit");
      }),
    ).rejects.toThrow("stop before commit");
    expect(emitSpy).not.toHaveBeenCalled();
    expect(fs.readFileSync(scope.sessionFile, "utf8")).toContain("durable but failed");
  });

  it("round-trips encoded memory hit keys with opaque session ids", () => {
    const key = formatSessionTranscriptMemoryHitKey({
      agentId: "SECONDARY",
      sessionId: "my-plugin:task/1",
    });

    expect(key).toBe("transcript:secondary:my-plugin%3Atask%2F1");
    expect(parseSessionTranscriptMemoryHitKey(key)).toEqual({
      agentId: "secondary",
      key,
      sessionId: "my-plugin:task/1",
    });
  });

  it("resolves memory hit keys by agent and session id instead of transcript basename", async () => {
    const scope = {
      agentId: "main",
      sessionId: "session-id",
      sessionKey: "agent:main:telegram:direct:123",
      storePath,
    };
    await upsertSessionEntry(scope, {
      sessionFile: path.join(tempDir, "legacy-file-name.jsonl"),
      sessionId: scope.sessionId,
      updatedAt: 10,
    });

    const keys = resolveSessionTranscriptMemoryHitKeyToSessionKeys({
      key: formatSessionTranscriptMemoryHitKey(scope),
      store: loadSessionStore(storePath),
    });

    expect(keys).toEqual(["agent:main:telegram:direct:123"]);
  });

  it("can avoid synthetic fallback keys for strict live-store checks", () => {
    const key = formatSessionTranscriptMemoryHitKey({
      agentId: "main",
      sessionId: "deleted-session",
    });

    expect(resolveSessionTranscriptMemoryHitKeyToSessionKeys({ key, store: {} })).toEqual([
      "agent:main:deleted-session",
    ]);
    expect(
      resolveSessionTranscriptMemoryHitKeyToSessionKeys({
        includeSyntheticFallback: false,
        key,
        store: {},
      }),
    ).toEqual([]);
  });
});
