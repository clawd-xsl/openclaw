// Session path helper tests pin default store path contracts used by CLI commands.
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveStorePath } from "./paths.js";

describe("resolveStorePath", () => {
  it("uses the default agent store when session.store is absent or blank", () => {
    const stateDir = path.join(path.parse(process.cwd()).root, "openclaw-test-state");
    const env = {
      ...process.env,
      OPENCLAW_STATE_DIR: stateDir,
    };
    const expected = path.join(stateDir, "agents", "work", "sessions", "sessions.sqlite");

    expect(resolveStorePath(undefined, { agentId: "work", env })).toBe(expected);
    expect(resolveStorePath("", { agentId: "work", env })).toBe(expected);
  });

  it("keeps legacy configured JSON paths on their sibling SQLite store", () => {
    const root = path.join(path.parse(process.cwd()).root, "openclaw-configured-store");

    expect(resolveStorePath(path.join(root, "sessions.json"))).toBe(
      path.join(root, "sessions.sqlite"),
    );
    expect(resolveStorePath(path.join(root, "sessions.hot.json"))).toBe(
      path.join(root, "sessions.sqlite"),
    );
    expect(
      resolveStorePath(path.join(root, "{agentId}", "sessions.json"), { agentId: "work" }),
    ).toBe(path.join(root, "work", "sessions.sqlite"));
  });

  it("leaves explicitly configured database paths unchanged", () => {
    const root = path.join(path.parse(process.cwd()).root, "openclaw-configured-store");

    expect(resolveStorePath(path.join(root, "sessions.db"))).toBe(path.join(root, "sessions.db"));
    expect(resolveStorePath(path.join(root, "sessions.sqlite"))).toBe(
      path.join(root, "sessions.sqlite"),
    );
  });

  it("preserves legacy SQLite suffixing for arbitrary configured path stems", () => {
    const root = path.join(path.parse(process.cwd()).root, "openclaw-configured-store");

    expect(resolveStorePath(path.join(root, "session-state"))).toBe(
      path.join(root, "session-state.sqlite"),
    );
    expect(resolveStorePath(path.join(root, "session-state.custom"))).toBe(
      path.join(root, "session-state.custom.sqlite"),
    );
    expect(resolveStorePath(path.join(root, "session-state.JSON"))).toBe(
      path.join(root, "session-state.JSON.sqlite"),
    );
  });
});
