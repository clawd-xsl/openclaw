import { describe, expect, it } from "vitest";
import { buildSignalRealtimeInstructions } from "./realtime.js";

describe("buildSignalRealtimeInstructions", () => {
  it("injects the context brief as a private block when present", () => {
    const out = buildSignalRealtimeInstructions({
      toolPolicy: "owner",
      consultPolicy: "always",
      contextBrief: "The caller is Alice; you were mid-planning her trip.",
    });
    expect(out).toContain("Briefing for this call");
    expect(out).toContain("do not read it aloud");
    expect(out).toContain("The caller is Alice; you were mid-planning her trip.");
  });

  it("omits the briefing block when there is no brief", () => {
    const out = buildSignalRealtimeInstructions({
      toolPolicy: "owner",
      consultPolicy: "always",
    });
    expect(out).not.toContain("Briefing for this call");
  });

  it("omits the briefing block for a blank brief", () => {
    const out = buildSignalRealtimeInstructions({
      toolPolicy: "owner",
      consultPolicy: "always",
      contextBrief: "   ",
    });
    expect(out).not.toContain("Briefing for this call");
  });
});
