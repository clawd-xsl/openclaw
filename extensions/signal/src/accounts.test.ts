import { describe, expect, it } from "vitest";
import { resolveSignalAccount, resolveSignalBlockStreamingEnabled } from "./accounts.js";

describe("resolveSignalAccount", () => {
  it("uses configured defaultAccount when accountId is omitted", () => {
    const resolved = resolveSignalAccount({
      cfg: {
        channels: {
          signal: {
            defaultAccount: "work",
            accounts: {
              work: {
                name: "Work",
                account: "+15555550123",
                httpUrl: "http://127.0.0.1:9999",
              },
            },
          },
        },
      } as never,
    });

    expect(resolved.accountId).toBe("work");
    expect(resolved.name).toBe("Work");
    expect(resolved.baseUrl).toBe("http://127.0.0.1:9999");
    expect(resolved.config.account).toBe("+15555550123");
    expect(resolved.configured).toBe(true);
  });
});

describe("resolveSignalBlockStreamingEnabled", () => {
  it("uses canonical nested streaming block config before legacy blockStreaming", () => {
    const resolved = resolveSignalBlockStreamingEnabled({
      blockStreaming: false,
      streaming: {
        block: {
          enabled: true,
        },
      },
    } as never);

    expect(resolved).toBe(true);
  });
});
