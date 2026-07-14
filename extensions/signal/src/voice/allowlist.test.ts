import { describe, expect, it } from "vitest";
import { isAllowedSignalCaller } from "./allowlist.js";

const peer = (aci: string) => ({ aci, deviceId: 1 });

describe("isAllowedSignalCaller", () => {
  it("denies by default when allowFrom is unset or empty", () => {
    expect(isAllowedSignalCaller(peer("abc-123"), undefined)).toBe(false);
    expect(isAllowedSignalCaller(peer("abc-123"), [])).toBe(false);
  });

  it("opens the line for a wildcard entry", () => {
    expect(isAllowedSignalCaller(peer("abc-123"), ["*"])).toBe(true);
  });

  it("matches a listed ACI case-insensitively and strips prefixes", () => {
    expect(isAllowedSignalCaller(peer("ABC-123"), ["abc-123"])).toBe(true);
    expect(isAllowedSignalCaller(peer("abc-123"), ["aci:ABC-123"])).toBe(true);
    expect(isAllowedSignalCaller(peer("abc-123"), ["signal:uuid:abc-123"])).toBe(true);
  });

  it("does not match an ACI that is absent from the list", () => {
    expect(isAllowedSignalCaller(peer("abc-123"), ["def-456"])).toBe(false);
  });

  it("treats e164/numeric entries as inert (offers carry no e164)", () => {
    expect(isAllowedSignalCaller(peer("abc-123"), ["+15551234567"])).toBe(false);
    expect(isAllowedSignalCaller(peer("abc-123"), [15551234567])).toBe(false);
  });

  it("never matches an empty ACI against an empty allowlist entry", () => {
    expect(isAllowedSignalCaller(peer(""), [""])).toBe(false);
    expect(isAllowedSignalCaller(peer("   "), ["signal:"])).toBe(false);
  });
});
