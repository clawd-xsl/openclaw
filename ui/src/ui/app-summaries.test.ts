import { describe, expect, it } from "vitest";
import { mountApp, registerAppMountHooks } from "./test-helpers/app-mount.ts";

registerAppMountHooks();

describe("summaries navigation", () => {
  it("renders summaries content when navigating from the sidebar", async () => {
    const app = mountApp("/chat");
    await app.updateComplete;

    const link = app.querySelector<HTMLAnchorElement>('a.nav-item[href="/summaries"]');
    expect(link).not.toBeNull();
    link?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));

    await app.updateComplete;

    expect(app.tab).toBe("summaries");
    expect(window.location.pathname).toBe("/summaries");
    expect(app.querySelector(".page-title")?.textContent).toContain("Session Summaries");
    expect(app.querySelector(".card-title")?.textContent).toContain("Session Summaries");
    expect(app.textContent).toContain("Browse and search past session summaries.");
  });
});
