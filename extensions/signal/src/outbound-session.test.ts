import { describe, expect, it } from "vitest";
import { resolveSignalOutboundTarget } from "./outbound-session.js";

describe("resolveSignalOutboundTarget", () => {
  it("emits the canonical bare target for direct recipients", () => {
    // Must match the inbound normalizeSignalMessagingTarget spelling: a
    // signal:-prefixed `to` broke origin/delivery route identity comparisons.
    const uuid = "0d3a7c42-1111-4222-8333-444455556666";
    const route = resolveSignalOutboundTarget(`signal:${uuid}`);
    expect(route).toMatchObject({
      chatType: "direct",
      from: `signal:${uuid}`,
      to: uuid,
    });
  });

  it("keeps the group-prefixed target for groups", () => {
    const route = resolveSignalOutboundTarget("signal:group:abc123==");
    expect(route).toMatchObject({ chatType: "group", to: "group:abc123==" });
  });
});
