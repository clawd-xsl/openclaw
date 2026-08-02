// One-shot main job tests cover disabling cron jobs after a single run.
import { describe, expect, it, vi } from "vitest";
import { resetSystemEventsForTest } from "../infra/system-events.js";
import type { CronEvent, CronServiceDeps } from "./service.js";
import { CronService } from "./service.js";
import {
  createCronStoreHarness,
  createDeferred,
  createNoopLogger,
  installCronTestHooks,
} from "./service.test-harness.js";

const noopLogger = createNoopLogger();
installCronTestHooks({ logger: noopLogger });
const { makeStorePath } = createCronStoreHarness({
  prefix: "openclaw-cron-runs-one-shot-",
});

function expectCronRunSessionKey(value: unknown, _jobId: string) {
  // Main-targeted jobs run directly on the agent's main session.
  expect(value).toBe("agent:main:main");
}

function createCronEventHarness() {
  const events: CronEvent[] = [];
  const waiters: Array<{
    predicate: (evt: CronEvent) => boolean;
    deferred: ReturnType<typeof createDeferred<CronEvent>>;
  }> = [];

  const onEvent = (evt: CronEvent) => {
    events.push(evt);
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      const waiter = waiters[i];
      if (waiter && waiter.predicate(evt)) {
        waiters.splice(i, 1);
        waiter.deferred.resolve(evt);
      }
    }
  };

  const waitFor = (predicate: (evt: CronEvent) => boolean) => {
    for (const evt of events) {
      if (predicate(evt)) {
        return Promise.resolve(evt);
      }
    }
    const deferred = createDeferred<CronEvent>();
    waiters.push({ predicate, deferred });
    return deferred.promise;
  };

  return { onEvent, waitFor, events };
}

type CronHarnessOptions = {
  runIsolatedAgentJob?: CronServiceDeps["runIsolatedAgentJob"];
  nowMs?: () => number;
  cronConfig?: CronServiceDeps["cronConfig"];
  withEvents?: boolean;
};

async function createCronHarness(options: CronHarnessOptions = {}) {
  const store = await makeStorePath();
  const enqueueSystemEvent = vi.fn();
  const requestHeartbeat = vi.fn();
  const requestSystemEventTurn = vi.fn();
  const events = options.withEvents === false ? undefined : createCronEventHarness();

  const cron = new CronService({
    storePath: store.storePath,
    cronEnabled: true,
    log: noopLogger,
    ...(options.nowMs ? { nowMs: options.nowMs } : {}),
    ...(options.cronConfig ? { cronConfig: options.cronConfig } : {}),
    enqueueSystemEvent,
    requestHeartbeat,
    requestSystemEventTurn,
    runIsolatedAgentJob:
      options.runIsolatedAgentJob ??
      (vi.fn(async (_params: { job: unknown; message: string }) => ({
        status: "ok",
      })) as unknown as CronServiceDeps["runIsolatedAgentJob"]),
    ...(events ? { onEvent: events.onEvent } : {}),
  });
  await cron.start();
  return {
    store,
    cron,
    enqueueSystemEvent,
    requestHeartbeat,
    requestSystemEventTurn,
    events,
  };
}

async function createMainOneShotHarness() {
  const harness = await createCronHarness();
  if (!harness.events) {
    throw new Error("missing event harness");
  }
  return { ...harness, events: harness.events };
}

async function createIsolatedAnnounceHarness(
  runIsolatedAgentJob: CronServiceDeps["runIsolatedAgentJob"],
) {
  const harness = await createCronHarness({
    runIsolatedAgentJob,
  });
  if (!harness.events) {
    throw new Error("missing event harness");
  }
  return { ...harness, events: harness.events };
}

async function addDefaultIsolatedAnnounceJob(cron: CronService, name: string) {
  const runAt = new Date("2025-12-13T00:00:01.000Z");
  const job = await cron.add({
    enabled: true,
    name,
    schedule: { kind: "at", at: runAt.toISOString() },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "do it" },
    delivery: { mode: "announce" },
  });
  return { job, runAt };
}

async function runIsolatedAnnounceJobAndWait(params: {
  cron: CronService;
  events: ReturnType<typeof createCronEventHarness>;
  name: string;
  status: "ok" | "error";
}) {
  const { job, runAt } = await addDefaultIsolatedAnnounceJob(params.cron, params.name);
  vi.setSystemTime(runAt);
  await vi.runOnlyPendingTimersAsync();
  await params.events.waitFor(
    (evt) => evt.jobId === job.id && evt.action === "finished" && evt.status === params.status,
  );
  return job;
}

async function runIsolatedAnnounceScenario(params: {
  cron: CronService;
  events: ReturnType<typeof createCronEventHarness>;
  name: string;
  status?: "ok" | "error";
}) {
  await runIsolatedAnnounceJobAndWait({
    cron: params.cron,
    events: params.events,
    name: params.name,
    status: params.status ?? "ok",
  });
}

async function addWakeModeNowMainSystemEventJob(
  cron: CronService,
  options?: { name?: string; agentId?: string; sessionKey?: string },
) {
  return cron.add({
    name: options?.name ?? "wakeMode now",
    ...(options?.agentId ? { agentId: options.agentId } : {}),
    ...(options?.sessionKey ? { sessionKey: options.sessionKey } : {}),
    enabled: true,
    schedule: { kind: "at", at: new Date(1).toISOString() },
    sessionTarget: "main",
    wakeMode: "now",
    payload: { kind: "systemEvent", text: "hello" },
  });
}

async function addMainOneShotHelloJob(
  cron: CronService,
  params: { atMs: number; name: string; deleteAfterRun?: boolean },
) {
  return cron.add({
    name: params.name,
    enabled: true,
    ...(params.deleteAfterRun === undefined ? {} : { deleteAfterRun: params.deleteAfterRun }),
    schedule: { kind: "at", at: new Date(params.atMs).toISOString() },
    sessionTarget: "main",
    wakeMode: "now",
    payload: { kind: "systemEvent", text: "hello" },
  });
}

function expectMainSystemEventPosted(
  enqueueSystemEvent: ReturnType<typeof vi.fn>,
  params: { text: string; jobId: string },
) {
  const matchingCall = enqueueSystemEvent.mock.calls.find(([text]) => text === params.text);
  if (!matchingCall) {
    throw new Error(`missing system event ${params.text}`);
  }
  const options = matchingCall[1] as Record<string, unknown>;
  expect(options).toMatchObject({
    agentId: undefined,
    contextKey: `cron:${params.jobId}`,
  });
  expectCronRunSessionKey(options.sessionKey, params.jobId);
}

function expectRequestedSystemEventTurn(
  requestSystemEventTurn: ReturnType<typeof vi.fn>,
  params: { jobId: string },
) {
  const request = requestSystemEventTurn.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
  expect(request).toMatchObject({
    reason: `cron:${params.jobId}`,
    agentId: undefined,
  });
  expectCronRunSessionKey(request?.sessionKey, params.jobId);
}

async function stopCronAndCleanup(cron: CronService, store: { cleanup: () => Promise<void> }) {
  await cron.status();
  cron.stop();
  await store.cleanup();
  resetSystemEventsForTest();
}

function createStartedCronService(
  storePath: string,
  runIsolatedAgentJob?: CronServiceDeps["runIsolatedAgentJob"],
) {
  return new CronService({
    storePath,
    cronEnabled: true,
    log: noopLogger,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    requestSystemEventTurn: vi.fn(),
    runIsolatedAgentJob: runIsolatedAgentJob ?? vi.fn(async () => ({ status: "ok" as const })),
  });
}

async function createMainOneShotJobHarness(params: { name: string; deleteAfterRun?: boolean }) {
  const harness = await createMainOneShotHarness();
  const atMs = Date.parse("2025-12-13T00:00:02.000Z");
  const job = await addMainOneShotHelloJob(harness.cron, {
    atMs,
    name: params.name,
    deleteAfterRun: params.deleteAfterRun,
  });
  return { ...harness, atMs, job };
}

async function expectNoMainSummaryForIsolatedRun(params: {
  runIsolatedAgentJob: CronServiceDeps["runIsolatedAgentJob"];
  name: string;
}) {
  const { store, cron, enqueueSystemEvent, requestHeartbeat, events } =
    await createIsolatedAnnounceHarness(params.runIsolatedAgentJob);
  await runIsolatedAnnounceScenario({
    cron,
    events,
    name: params.name,
  });
  expect(enqueueSystemEvent).not.toHaveBeenCalled();
  expect(requestHeartbeat).not.toHaveBeenCalled();
  await stopCronAndCleanup(cron, store);
}

describe("CronService", () => {
  it("runs a one-shot main job and disables it after success when requested", async () => {
    const { store, cron, enqueueSystemEvent, requestSystemEventTurn, events, atMs, job } =
      await createMainOneShotJobHarness({ name: "one-shot hello", deleteAfterRun: false });

    expect(job.state.nextRunAtMs).toBe(atMs);

    vi.setSystemTime(new Date("2025-12-13T00:00:02.000Z"));
    await vi.runOnlyPendingTimersAsync();
    await events.waitFor((evt) => evt.jobId === job.id && evt.action === "finished");

    const jobs = await cron.list({ includeDisabled: true });
    const updated = jobs.find((j) => j.id === job.id);
    expect(updated?.enabled).toBe(false);
    expectMainSystemEventPosted(enqueueSystemEvent, { text: "hello", jobId: job.id });
    expectRequestedSystemEventTurn(requestSystemEventTurn, { jobId: job.id });

    await cron.list({ includeDisabled: true });
    await stopCronAndCleanup(cron, store);
  });

  it("runs a one-shot job and deletes it after success by default", async () => {
    const { store, cron, enqueueSystemEvent, requestSystemEventTurn, events, job } =
      await createMainOneShotJobHarness({
        name: "one-shot delete",
      });

    vi.setSystemTime(new Date("2025-12-13T00:00:02.000Z"));
    await vi.runOnlyPendingTimersAsync();
    await events.waitFor((evt) => evt.jobId === job.id && evt.action === "removed");

    const jobs = await cron.list({ includeDisabled: true });
    expect(jobs.find((j) => j.id === job.id)).toBeUndefined();
    expectMainSystemEventPosted(enqueueSystemEvent, { text: "hello", jobId: job.id });
    expectRequestedSystemEventTurn(requestSystemEventTurn, { jobId: job.id });

    await stopCronAndCleanup(cron, store);
  });

  it("wakeMode now requests a system event turn without waiting for heartbeat", async () => {
    const { store, cron, enqueueSystemEvent, requestHeartbeat, requestSystemEventTurn } =
      await createCronHarness({ withEvents: false });
    const job = await addWakeModeNowMainSystemEventJob(cron, { name: "wakeMode now" });

    await cron.run(job.id, "force");

    expectMainSystemEventPosted(enqueueSystemEvent, { text: "hello", jobId: job.id });
    expectRequestedSystemEventTurn(requestSystemEventTurn, { jobId: job.id });
    expect(requestHeartbeat).not.toHaveBeenCalled();
    expect(job.state.lastStatus).toBe("ok");

    await stopCronAndCleanup(cron, store);
  });

  it("rejects sessionTarget main for non-default agents at creation time", async () => {
    const { store, cron } = await createCronHarness({ withEvents: false });

    await expect(
      addWakeModeNowMainSystemEventJob(cron, {
        name: "wakeMode now with agent",
        agentId: "ops",
      }),
    ).rejects.toThrow('cron: sessionTarget "main" is only valid for the default agent');

    await stopCronAndCleanup(cron, store);
  });

  it("runs an isolated job without posting a fallback summary to main", async () => {
    const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const, summary: "done" }));
    const { store, cron, enqueueSystemEvent, requestHeartbeat, events } =
      await createIsolatedAnnounceHarness(runIsolatedAgentJob);
    await runIsolatedAnnounceScenario({ cron, events, name: "weekly" });
    expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
    expect(requestHeartbeat).not.toHaveBeenCalled();
    await stopCronAndCleanup(cron, store);
  });

  it("does not post isolated summary to main when run already delivered output", async () => {
    const runIsolatedAgentJob = vi.fn(async () => ({
      status: "ok" as const,
      summary: "done",
      delivered: true,
    }));
    await expectNoMainSummaryForIsolatedRun({
      runIsolatedAgentJob,
      name: "weekly delivered",
    });
    expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);
  });

  it("does not post isolated summary to main when announce delivery was attempted", async () => {
    const runIsolatedAgentJob = vi.fn(async () => ({
      status: "ok" as const,
      summary: "done",
      delivered: false,
      deliveryAttempted: true,
    }));
    await expectNoMainSummaryForIsolatedRun({
      runIsolatedAgentJob,
      name: "weekly attempted",
    });
    expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);
  });

  it("does not post a fallback main summary when an isolated job errors", async () => {
    const runIsolatedAgentJob = vi.fn(async () => ({
      status: "error" as const,
      summary: "last output",
      error: "boom",
    }));
    const { store, cron, enqueueSystemEvent, requestHeartbeat, events } =
      await createIsolatedAnnounceHarness(runIsolatedAgentJob);
    await runIsolatedAnnounceJobAndWait({
      cron,
      events,
      name: "isolated error test",
      status: "error",
    });

    expect(enqueueSystemEvent).not.toHaveBeenCalled();
    expect(requestHeartbeat).not.toHaveBeenCalled();
    await stopCronAndCleanup(cron, store);
  });

  it("does not post fallback main summary for isolated delivery-target errors", async () => {
    const runIsolatedAgentJob = vi.fn(async () => ({
      status: "error" as const,
      summary: "last output",
      error: "Channel is required when multiple channels are configured: telegram, discord",
      errorKind: "delivery-target" as const,
    }));
    const { store, cron, enqueueSystemEvent, requestHeartbeat, events } =
      await createIsolatedAnnounceHarness(runIsolatedAgentJob);
    await runIsolatedAnnounceJobAndWait({
      cron,
      events,
      name: "isolated delivery target error test",
      status: "error",
    });

    expect(enqueueSystemEvent).not.toHaveBeenCalled();
    expect(requestHeartbeat).not.toHaveBeenCalled();
    await stopCronAndCleanup(cron, store);
  });

  it("rejects unsupported session/payload combinations", async () => {
    const store = await makeStorePath();

    const cron = createStartedCronService(
      store.storePath,
      vi.fn(async (_params: { job: unknown; message: string }) => ({
        status: "ok" as const,
      })) as unknown as CronServiceDeps["runIsolatedAgentJob"],
    );

    await cron.start();

    await expect(
      cron.add({
        name: "bad combo (main/agentTurn)",
        enabled: true,
        schedule: { kind: "every", everyMs: 1000 },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "agentTurn", message: "nope" },
      }),
    ).rejects.toThrow(/main cron jobs require/);

    await expect(
      cron.add({
        name: "bad combo (isolated/systemEvent)",
        enabled: true,
        schedule: { kind: "every", everyMs: 1000 },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "nope" },
      }),
    ).rejects.toThrow(/isolated.*cron jobs require/);

    await stopCronAndCleanup(cron, store);
  });
});
