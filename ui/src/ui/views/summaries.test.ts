/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { SessionSummaryHistoryItem } from "../controllers/summaries.ts";
import { renderSessionSummaries, type SessionSummariesProps } from "./summaries.ts";

function buildItem(
  status: SessionSummaryHistoryItem["status"],
  overrides: Partial<SessionSummaryHistoryItem> = {},
): SessionSummaryHistoryItem {
  return {
    agentId: "main",
    sessionId: `session-${status}`,
    sessionKey: `agent:main:${status}`,
    status,
    endedAt: "2026-07-05T12:00:00.000Z",
    messageCount: 12,
    model: "claude-opus-4-8",
    attemptCount: status === "failed" ? 3 : 1,
    ...overrides,
  };
}

function buildProps(overrides: Partial<SessionSummariesProps> = {}): SessionSummariesProps {
  return {
    items: [],
    loading: false,
    loadingMore: false,
    error: null,
    unavailable: false,
    nextCursor: null,
    selectedAgentId: null,
    agentOptions: [
      { id: "main", label: "Main" },
      { id: "research", label: "Research" },
    ],
    searchInput: "",
    query: "",
    onSelectAgent: vi.fn(),
    onSearchInput: vi.fn(),
    onSearch: vi.fn(),
    onClearSearch: vi.fn(),
    onRefresh: vi.fn(),
    onLoadMore: vi.fn(),
    ...overrides,
  };
}

function renderInto(props: SessionSummariesProps): HTMLDivElement {
  const container = document.createElement("div");
  render(renderSessionSummaries(props), container);
  return container;
}

describe("session summaries view", () => {
  it("renders pending, failed, and complete cards with lineage metadata", () => {
    const props = buildProps({
      items: [
        buildItem("pending"),
        buildItem("failed", { lastError: "provider timed out" }),
        buildItem("complete", {
          nextSessionId: "session-next",
          generatedAt: "2026-07-05T12:01:00.000Z",
          summary: "The migration plan was approved.",
        }),
      ],
      nextCursor: "cursor-2",
    });
    const container = renderInto(props);

    expect(container.querySelectorAll(".summary-card")).toHaveLength(3);
    expect(container.querySelector(".summary-card--pending")?.textContent).toContain(
      "Summary generation is pending.",
    );
    expect(container.querySelector(".summary-card--failed")?.textContent).toContain(
      "provider timed out",
    );
    const complete = container.querySelector(".summary-card--complete");
    expect(complete?.textContent).toContain("The migration plan was approved.");
    expect(complete?.textContent).toContain("session-complete → session-next");
    expect(complete?.textContent).toContain("claude-opus-4-8");
    expect(complete?.textContent).toContain("12");

    const loadMore = container.querySelector<HTMLButtonElement>(".summaries-pagination .btn");
    loadMore?.click();
    expect(props.onLoadMore).toHaveBeenCalledOnce();
  });

  it.each([
    {
      name: "loading",
      overrides: { loading: true },
      selector: ".summaries-state--loading",
      text: "Loading summary history",
    },
    {
      name: "unavailable",
      overrides: { unavailable: true },
      selector: ".summaries-state--unavailable",
      text: "Summary history unavailable",
    },
    {
      name: "error",
      overrides: { error: "gateway failed" },
      selector: ".summaries-state--error",
      text: "gateway failed",
    },
    {
      name: "empty",
      overrides: {},
      selector: ".summaries-state--empty",
      text: "No session summaries yet",
    },
  ])("renders the $name state", ({ overrides, selector, text }) => {
    const container = renderInto(buildProps(overrides));

    expect(container.querySelector(selector)?.textContent).toContain(text);
  });

  it("submits server search and agent filter controls", () => {
    const props = buildProps({ searchInput: "rollover", query: "rollover" });
    const container = renderInto(props);
    const search = container.querySelector<HTMLInputElement>('input[type="search"]');
    const agent = container.querySelector<HTMLSelectElement>("select");
    const form = container.querySelector<HTMLFormElement>("form");

    if (!search || !agent || !form) {
      throw new Error("Expected summary search controls");
    }
    expect(search.maxLength).toBe(512);
    search.value = "memory";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    agent.value = "research";
    agent.dispatchEvent(new Event("change", { bubbles: true }));
    form.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));

    expect(props.onSearchInput).toHaveBeenCalledWith("memory");
    expect(props.onSelectAgent).toHaveBeenCalledWith("research");
    expect(props.onSearch).toHaveBeenCalledOnce();
  });
});
