import { describe, expect, it, vi } from "vitest";
import { CronService } from "./service.js";
import { setupCronServiceSuite, writeCronStoreSnapshot } from "./service.test-harness.js";
import type { CronJob } from "./types.js";

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "cron-main-synthetic-turn",
});

function createMainCronJob(params: {
  now: number;
  id: string;
  wakeMode: CronJob["wakeMode"];
}): CronJob {
  return {
    id: params.id,
    name: params.id,
    enabled: true,
    createdAtMs: params.now - 10_000,
    updatedAtMs: params.now - 10_000,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "main",
    wakeMode: params.wakeMode,
    payload: { kind: "systemEvent", text: "Check in" },
    state: { nextRunAtMs: params.now - 1 },
  };
}

async function runSingleTick(cron: CronService) {
  await cron.start();
  await vi.advanceTimersByTimeAsync(2_000);
  await vi.advanceTimersByTimeAsync(1_000);
  cron.stop();
}

describe("cron main job synthetic turn wake", () => {
  it("queues the main-session system event and requests a synthetic main turn", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.now();
    const job = createMainCronJob({
      now,
      id: "test-main-synthetic-turn",
      wakeMode: "now",
    });
    await writeCronStoreSnapshot({ storePath, jobs: [job] });

    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();
    const requestMainAgentTurn = vi.fn();
    const runHeartbeatOnce = vi.fn(async () => ({
      status: "ran" as const,
      durationMs: 50,
    }));
    const cron = new CronService({
      storePath,
      cronEnabled: true,
      log: logger,
      enqueueSystemEvent,
      requestHeartbeatNow,
      requestMainAgentTurn,
      runHeartbeatOnce,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    await runSingleTick(cron);

    expect(enqueueSystemEvent).toHaveBeenCalledWith("Check in", {
      agentId: undefined,
      sessionKey: undefined,
      contextKey: "cron:test-main-synthetic-turn",
    });
    expect(requestMainAgentTurn).toHaveBeenCalledWith({
      reason: "cron:test-main-synthetic-turn",
      agentId: undefined,
      sessionKey: undefined,
    });
    expect(runHeartbeatOnce).not.toHaveBeenCalled();
    expect(requestHeartbeatNow).not.toHaveBeenCalled();
  });
});
