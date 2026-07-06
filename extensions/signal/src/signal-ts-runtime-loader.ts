type SignalTsRuntimeModule = typeof import("./signal-ts-runtime.js");

let signalTsRuntimePromise: Promise<SignalTsRuntimeModule> | undefined;

function isMissingHostSignalTsPackage(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const code = "code" in error && typeof error.code === "string" ? error.code : "";
  const message = "message" in error && typeof error.message === "string" ? error.message : "";
  return (
    (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") &&
    message.includes("@openclaw/signal-ts")
  );
}

/** Load the direct Signal runtime only when the configured account selects it. */
export async function loadSignalTsRuntime(): Promise<SignalTsRuntimeModule> {
  signalTsRuntimePromise ??= import("./signal-ts-runtime.js").catch((error: unknown) => {
    signalTsRuntimePromise = undefined;
    if (isMissingHostSignalTsPackage(error)) {
      throw new Error(
        "Signal direct backend requires the host environment to provide @openclaw/signal-ts",
        { cause: error },
      );
    }
    throw error;
  });
  return await signalTsRuntimePromise;
}
