/**
 * Test helpers for seeding and observing compaction counts in session stores.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { resolveStorePath } from "../config/sessions/paths.js";
import { loadSessionStore } from "../config/sessions/store.js";

export async function seedSessionStore(params: {
  storePath: string;
  sessionKey: string;
  compactionCount: number;
  updatedAt?: number;
}) {
  await fs.mkdir(path.dirname(params.storePath), { recursive: true });
  await fs.writeFile(
    params.storePath,
    JSON.stringify(
      {
        [params.sessionKey]: {
          sessionId: "session-1",
          updatedAt: params.updatedAt ?? 1_000,
          compactionCount: params.compactionCount,
        },
      },
      null,
      2,
    ),
    "utf-8",
  );
}

export async function readCompactionCount(storePath: string, sessionKey: string): Promise<number> {
  const backendStorePath = resolveStorePath(storePath);
  const store = loadSessionStore(backendStorePath, {
    hydrateSkillPromptRefs: false,
    skipCache: true,
  });
  return store[sessionKey]?.compactionCount ?? 0;
}

export async function waitForCompactionCount(params: {
  storePath: string;
  sessionKey: string;
  expected: number;
}) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if ((await readCompactionCount(params.storePath, params.sessionKey)) === params.expected) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  throw new Error(`timed out waiting for compactionCount=${params.expected}`);
}
