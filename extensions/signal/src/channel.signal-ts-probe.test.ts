import { beforeEach, describe, expect, it, vi } from "vitest";

const probeSignalTsAccount = vi.hoisted(() => vi.fn());

vi.mock("./signal-ts-runtime.js", () => ({
  probeSignalTsAccount: (...args: unknown[]) => probeSignalTsAccount(...args),
}));

const { signalPlugin } = await import("./channel.js");

describe("Signal signal-ts status probe", () => {
  beforeEach(() => {
    probeSignalTsAccount.mockReset().mockResolvedValue({
      ok: true,
      status: null,
      error: null,
      elapsedMs: 7,
      version: "signal-ts",
    });
  });

  it("lazily validates durable state and the authenticated connection", async () => {
    const account = {
      accountId: "default",
      enabled: true,
      configured: true,
      baseUrl: "http://127.0.0.1:8080",
      config: {
        backend: "signal-ts",
        signalTsStatePath: "/secure/signal/default.json",
      },
    } as never;

    const result = await signalPlugin.status!.probeAccount!({
      cfg: {} as never,
      account,
      timeoutMs: 1500,
    });

    expect(result).toEqual(
      expect.objectContaining({ ok: true, elapsedMs: 7, version: "signal-ts" }),
    );
    expect(probeSignalTsAccount).toHaveBeenCalledWith({
      accountInfo: account,
      timeoutMs: 1500,
    });
  });
});
