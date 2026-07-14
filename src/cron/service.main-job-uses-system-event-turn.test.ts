// Main job wake tests keep immediate event turns separate from periodic heartbeats.
import { describe, expect, it, vi } from "vitest";
import { CronService } from "./service.js";
import { setupCronServiceSuite, writeCronStoreSnapshot } from "./service.test-harness.js";
import type { CronServiceDeps } from "./service/state.js";
import type { CronJob } from "./types.js";

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "cron-main-system-event-turn",
});

describe("cron main job wake routing", () => {
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

  function createCronWithSpies(storePath: string) {
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeat = vi.fn();
    const requestSystemEventTurn = vi.fn<CronServiceDeps["requestSystemEventTurn"]>(async () => {});
    const cron = new CronService({
      storePath,
      cronEnabled: true,
      log: logger,
      enqueueSystemEvent,
      requestHeartbeat,
      requestSystemEventTurn,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });
    return { cron, enqueueSystemEvent, requestHeartbeat, requestSystemEventTurn };
  }

  async function runSingleTick(cron: CronService) {
    const startPromise = cron.start();
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await startPromise;
    cron.stop();
  }

  it("uses a system event turn for wakeMode=now without invoking heartbeat", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.now();
    const job = createMainCronJob({ now, id: "test-main-delivery", wakeMode: "now" });
    await writeCronStoreSnapshot({ storePath, jobs: [job] });
    const { cron, enqueueSystemEvent, requestHeartbeat, requestSystemEventTurn } =
      createCronWithSpies(storePath);

    await runSingleTick(cron);

    expect(requestHeartbeat).not.toHaveBeenCalled();
    expect(requestSystemEventTurn).toHaveBeenCalledWith({
      reason: "cron:test-main-delivery",
      agentId: undefined,
      sessionKey: expect.stringMatching(/^agent:main:cron:test-main-delivery:run:\d+$/),
      abortSignal: expect.objectContaining({ aborted: false }),
    });
    const enqueueOptions = enqueueSystemEvent.mock.calls[0]?.[1] as { sessionKey?: string };
    const turnOptions = requestSystemEventTurn.mock.calls[0]?.[0] as { sessionKey?: string };
    expect(enqueueOptions.sessionKey).toBe(turnOptions.sessionKey);
  });

  it("keeps wakeMode=next-heartbeat deferred to the heartbeat scheduler", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.now();
    const job = createMainCronJob({
      now,
      id: "test-next-heartbeat",
      wakeMode: "next-heartbeat",
    });
    await writeCronStoreSnapshot({ storePath, jobs: [job] });
    const { cron, enqueueSystemEvent, requestHeartbeat, requestSystemEventTurn } =
      createCronWithSpies(storePath);

    await runSingleTick(cron);

    expect(requestSystemEventTurn).not.toHaveBeenCalled();
    expect(requestHeartbeat).toHaveBeenCalledWith({
      source: "cron",
      intent: "event",
      reason: "cron:test-next-heartbeat",
      agentId: undefined,
      sessionKey: expect.stringMatching(/^agent:main:cron:test-next-heartbeat:run:\d+$/),
      heartbeat: { target: "last" },
    });
    const enqueueOptions = enqueueSystemEvent.mock.calls[0]?.[1] as { sessionKey?: string };
    const heartbeatOptions = requestHeartbeat.mock.calls[0]?.[0] as { sessionKey?: string };
    expect(enqueueOptions.sessionKey).toBe(heartbeatOptions.sessionKey);
  });
});
