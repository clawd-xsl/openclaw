import { fileURLToPath } from "node:url";

const JAVASCRIPT_DATA_URL_PREFIX = "data:text/javascript,";
const TYPESCRIPT_WORKER_PATH = /\.(?:[cm]?ts|tsx)$/u;

export type SourceWorkerLaunch = {
  workerUrl: URL;
  execArgv?: string[];
};

/** Resolve an entrypoint that can load a TypeScript worker from a source checkout. */
export function resolveSourceWorkerLaunch(workerUrl: URL): SourceWorkerLaunch {
  if (workerUrl.protocol !== "file:" || !TYPESCRIPT_WORKER_PATH.test(workerUrl.pathname)) {
    return { workerUrl };
  }

  // tsx does not auto-register from `--import tsx` in Node 22 worker threads.
  // Start in JavaScript, then scoped-import the TS entrypoint so its `.js` imports resolve.
  const tsxApiUrl = import.meta.resolve("tsx/esm/api");
  const workerUrlJson = JSON.stringify(workerUrl.href);
  const tsconfigPathJson = JSON.stringify(
    fileURLToPath(new URL("../../tsconfig.json", import.meta.url)),
  );
  const bootstrap = [
    `import { tsImport } from ${JSON.stringify(tsxApiUrl)};`,
    `await tsImport(${workerUrlJson}, {`,
    "  parentURL: import.meta.url,",
    `  tsconfig: ${tsconfigPathJson},`,
    "});",
  ].join("\n");
  return {
    workerUrl: new URL(`${JAVASCRIPT_DATA_URL_PREFIX}${encodeURIComponent(bootstrap)}`),
    // Source workers must not inherit Vitest/CLI loaders, --input-type, or inspect flags.
    execArgv: [],
  };
}
