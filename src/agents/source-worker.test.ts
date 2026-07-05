import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import { resolveSourceWorkerLaunch } from "./source-worker.js";

describe("resolveSourceWorkerLaunch", () => {
  it("keeps compiled workers direct", () => {
    const workerUrl = new URL("file:///repo/dist/agents/example.worker.js");

    expect(resolveSourceWorkerLaunch(workerUrl)).toEqual({ workerUrl });
  });

  it("runs a TypeScript source worker with JavaScript import specifiers", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-source-worker-"));
    const workerPath = path.join(tempDir, "example.worker.ts");
    try {
      await fs.writeFile(path.join(tempDir, "package.json"), '{"type":"module"}\n');
      await fs.writeFile(path.join(tempDir, "value.ts"), "export enum Value { Expected = 42 }\n");
      await fs.writeFile(
        workerPath,
        [
          'import { parentPort } from "node:worker_threads";',
          'import { Value } from "./value.js";',
          "const result: number = Value.Expected;",
          "parentPort?.postMessage(result);",
        ].join("\n"),
      );

      const launch = resolveSourceWorkerLaunch(pathToFileURL(workerPath));
      const worker = new Worker(launch.workerUrl, { execArgv: launch.execArgv });
      try {
        const [message] = await once(worker, "message");
        expect(message).toBe(42);
      } finally {
        await worker.terminate();
      }
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
