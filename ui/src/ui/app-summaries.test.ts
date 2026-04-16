import { describe, expect, it } from "vitest";
import { mountApp, registerAppMountHooks } from "./test-helpers/app-mount.ts";

registerAppMountHooks();

function nextFrame() {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

describe("summaries navigation", () => {
  it("renders summaries content when navigating to the summaries tab", async () => {
    const app = mountApp("/summaries");
    await app.updateComplete;
    await nextFrame();
    await app.updateComplete;

    expect(app.tab).toBe("summaries");
    expect(window.location.pathname).toBe("/summaries");
    expect(app.querySelector(".page-title")?.textContent).toContain("Session Summaries");
    expect(app.querySelector(".card-title")?.textContent).toContain("Session Summaries");
    expect(app.textContent).toContain("Browse and search past session summaries.");
  });
});
