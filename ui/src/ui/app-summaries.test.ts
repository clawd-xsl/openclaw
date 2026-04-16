import { describe, expect, it } from "vitest";
import { i18n } from "../i18n/index.ts";
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

  it("renders localized summaries copy when the UI locale is zh-CN", async () => {
    await i18n.setLocale("zh-CN");
    const app = mountApp("/summaries");
    await app.updateComplete;
    await nextFrame();
    await app.updateComplete;

    expect(app.tab).toBe("summaries");
    expect(app.querySelector(".page-title")?.textContent).toContain("会话摘要");
    expect(app.querySelector(".card-title")?.textContent).toContain("会话摘要");
    expect(app.textContent).toContain("浏览并搜索过去的会话摘要。");
  });
});
