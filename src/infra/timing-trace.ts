import { getLogger } from "../logging/logger.js";
import { isTruthyEnvValue } from "./env.js";

export const OPENCLAW_TIMING_TRACE_ENV = "OPENCLAW_DEBUG_TIMING";
const OPENCLAW_LEGACY_TIMING_TRACE_ENV = "OPENCLAW_DEBUG_INGRESS_TIMING";

export type TimingTraceWriter = (line: string) => void;

export type TimingTraceSink = "logger" | "stderr" | TimingTraceWriter;

export type TimingTraceOptions = {
  channel: string;
  label: string;
  scope?: string;
  sink?: TimingTraceSink;
  enabled?: boolean;
  startedAtMs?: number;
};

function writeTimingTraceToLogger(line: string): void {
  try {
    getLogger().info({ message: line }, "timing-trace");
  } catch {
    try {
      process.stderr.write(`${line}\n`);
    } catch {
      // Best-effort tracing only.
    }
  }
}

function writeTimingTraceToStderr(line: string): void {
  try {
    process.stderr.write(`${line}\n`);
  } catch {
    // Best-effort tracing only.
  }
}

export function isTimingTraceEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    isTruthyEnvValue(env[OPENCLAW_TIMING_TRACE_ENV]) ||
    isTruthyEnvValue(env[OPENCLAW_LEGACY_TIMING_TRACE_ENV])
  );
}

export function resolveTimingTraceWriter(sink: TimingTraceSink = "logger"): TimingTraceWriter {
  if (sink === "logger") {
    return writeTimingTraceToLogger;
  }
  if (sink === "stderr") {
    return writeTimingTraceToStderr;
  }
  return sink;
}

export function createTimingTrace(options: TimingTraceOptions) {
  const enabled = options.enabled ?? isTimingTraceEnabled();
  if (!enabled) {
    return (_stage: string, _details?: string) => {};
  }

  const startedAtMs = options.startedAtMs ?? Date.now();
  const write = resolveTimingTraceWriter(options.sink);

  return (stage: string, details?: string) => {
    const suffix = details ? ` ${details}` : "";
    const scopePrefix = options.scope ? `${options.scope}:` : "";
    write(
      `[${options.channel} ${options.label}] ${scopePrefix}${stage} +${Date.now() - startedAtMs}ms${suffix}`,
    );
  };
}
