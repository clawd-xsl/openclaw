// Signal tests cover send reactions plugin behavior.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const rpcMock = vi.fn();
const signalTsReactionMock = vi.hoisted(() => vi.fn());
const accountState = vi.hoisted(() => ({
  config: { account: "+15550001111" } as {
    account?: string;
    backend?: "signal-cli" | "signal-ts";
    signalTsStatePath?: string;
  },
}));

vi.mock("openclaw/plugin-sdk/plugin-config-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/plugin-config-runtime")>(
    "openclaw/plugin-sdk/plugin-config-runtime",
  );
  return {
    ...actual,
    loadConfig: () => ({}),
  };
});

vi.mock("./accounts.js", () => ({
  resolveSignalAccount: () => ({
    accountId: "default",
    enabled: true,
    baseUrl: "http://signal.local",
    configured: true,
    config: accountState.config,
  }),
  resolveSignalBackend: () => accountState.config.backend ?? "signal-cli",
}));

vi.mock("./client-adapter.js", () => ({
  signalRpcRequest: (...args: unknown[]) => rpcMock(...args),
}));

vi.mock("./signal-ts-runtime.js", () => ({
  sendReactionSignalTs: (...args: unknown[]) => signalTsReactionMock(...args),
}));

let sendReactionSignal: typeof import("./send-reactions.js").sendReactionSignal;
let removeReactionSignal: typeof import("./send-reactions.js").removeReactionSignal;

const SIGNAL_TEST_CFG = {
  channels: {
    signal: {
      accounts: {
        default: {},
      },
    },
  },
};

function requireRpcParams(): Record<string, unknown> {
  const [call] = rpcMock.mock.calls;
  if (!call) {
    throw new Error("expected Signal RPC call");
  }
  const [, params] = call;
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new Error("expected Signal RPC params");
  }
  return params as Record<string, unknown>;
}

describe("sendReactionSignal", () => {
  beforeAll(async () => {
    ({ sendReactionSignal, removeReactionSignal } = await import("./send-reactions.js"));
  });

  beforeEach(() => {
    rpcMock.mockClear().mockResolvedValue({ timestamp: 123 });
    accountState.config = { account: "+15550001111" };
    signalTsReactionMock.mockReset().mockResolvedValue({
      messageId: "1700000000000",
      timestamp: 1700000000000,
    });
  });

  it("uses recipients array and targetAuthor for uuid dms", async () => {
    await sendReactionSignal("uuid:123e4567-e89b-12d3-a456-426614174000", 123, "🔥", {
      cfg: SIGNAL_TEST_CFG,
    });

    expect(rpcMock).toHaveBeenCalledWith(
      "sendReaction",
      {
        emoji: "🔥",
        targetTimestamp: 123,
        targetAuthor: "123e4567-e89b-12d3-a456-426614174000",
        recipients: ["123e4567-e89b-12d3-a456-426614174000"],
        account: "+15550001111",
      },
      {
        baseUrl: "http://signal.local",
        timeoutMs: undefined,
        apiMode: undefined,
      },
    );
    const params = requireRpcParams();
    expect(params.recipients).toEqual(["123e4567-e89b-12d3-a456-426614174000"]);
    expect(params.groupIds).toBeUndefined();
    expect(params.targetAuthor).toBe("123e4567-e89b-12d3-a456-426614174000");
    expect(params).not.toHaveProperty("recipient");
    expect(params).not.toHaveProperty("groupId");
  });

  it("uses groupIds array and maps targetAuthorUuid", async () => {
    await sendReactionSignal("", 123, "✅", {
      cfg: SIGNAL_TEST_CFG,
      groupId: "group-id",
      targetAuthorUuid: "uuid:123e4567-e89b-12d3-a456-426614174000",
    });

    const params = requireRpcParams();
    expect(params.recipients).toBeUndefined();
    expect(params.groupIds).toEqual(["group-id"]);
    expect(params.targetAuthor).toBe("123e4567-e89b-12d3-a456-426614174000");
  });

  it("defaults targetAuthor to recipient for removals", async () => {
    await removeReactionSignal("+15551230000", 456, "❌", { cfg: SIGNAL_TEST_CFG });

    const params = requireRpcParams();
    expect(params.recipients).toEqual(["+15551230000"]);
    expect(params.targetAuthor).toBe("+15551230000");
    expect(params.remove).toBe(true);
  });

  it("routes direct and group reactions through signal-ts", async () => {
    accountState.config = {
      backend: "signal-ts",
      signalTsStatePath: "/secure/signal/default.json",
    };

    const direct = await sendReactionSignal(
      "uuid:123e4567-e89b-12d3-a456-426614174000",
      123,
      "🔥",
      {
        cfg: SIGNAL_TEST_CFG,
      },
    );
    const group = await removeReactionSignal("", 456, "❌", {
      cfg: SIGNAL_TEST_CFG,
      groupId: "group-id",
      targetAuthorUuid: "uuid:123e4567-e89b-12d3-a456-426614174000",
    });

    expect(rpcMock).not.toHaveBeenCalled();
    expect(signalTsReactionMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        to: "123e4567-e89b-12d3-a456-426614174000",
        targetTimestamp: 123,
        emoji: "🔥",
        remove: false,
      }),
    );
    expect(signalTsReactionMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        to: "signal:group:group-id",
        groupId: "group-id",
        targetTimestamp: 456,
        remove: true,
      }),
    );
    expect(direct).toEqual({ ok: true, timestamp: 1700000000000 });
    expect(group).toEqual({ ok: true, timestamp: 1700000000000 });
  });
});
