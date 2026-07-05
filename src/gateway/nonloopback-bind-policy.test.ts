import { describe, expect, it } from "vitest";
import { shouldBlockGatewayBindWithoutAuth } from "./nonloopback-bind-policy.js";

describe("shouldBlockGatewayBindWithoutAuth", () => {
  it.each([
    {
      name: "explicit custom bind with explicit no-auth",
      bindMode: "custom" as const,
      authMode: "none" as const,
      hasSharedSecret: false,
      expected: false,
    },
    {
      name: "LAN bind with no-auth",
      bindMode: "lan" as const,
      authMode: "none" as const,
      hasSharedSecret: false,
      expected: true,
    },
    {
      name: "auto bind with no-auth",
      bindMode: "auto" as const,
      authMode: "none" as const,
      hasSharedSecret: false,
      expected: true,
    },
    {
      name: "custom token bind without a token",
      bindMode: "custom" as const,
      authMode: "token" as const,
      hasSharedSecret: false,
      expected: true,
    },
    {
      name: "LAN token bind with a token",
      bindMode: "lan" as const,
      authMode: "token" as const,
      hasSharedSecret: true,
      expected: false,
    },
    {
      name: "LAN trusted proxy bind",
      bindMode: "lan" as const,
      authMode: "trusted-proxy" as const,
      hasSharedSecret: false,
      expected: false,
    },
  ])("handles $name", ({ bindMode, authMode, hasSharedSecret, expected }) => {
    expect(
      shouldBlockGatewayBindWithoutAuth({
        bindMode,
        authMode,
        hasSharedSecret,
        isLoopback: false,
      }),
    ).toBe(expected);
  });

  it("always allows a resolved loopback host", () => {
    expect(
      shouldBlockGatewayBindWithoutAuth({
        bindMode: "auto",
        authMode: "none",
        hasSharedSecret: false,
        isLoopback: true,
      }),
    ).toBe(false);
  });
});
