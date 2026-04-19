// Manual facade. Keep loader boundary explicit.
type FacadeModule = typeof import("@openclaw/anthropic/api.js");
import { loadBundledPluginPublicSurfaceModuleSync } from "./facade-loader.js";

function loadFacadeModule(): FacadeModule {
  return loadBundledPluginPublicSurfaceModuleSync<FacadeModule>({
    dirName: "anthropic",
    artifactBasename: "api.js",
  });
}
export const CLAUDE_CLI_BACKEND_ID: FacadeModule["CLAUDE_CLI_BACKEND_ID"] =
  loadFacadeModule()["CLAUDE_CLI_BACKEND_ID"];
export const CLAUDE_CLI_STREAMING_BACKEND_ID: FacadeModule["CLAUDE_CLI_STREAMING_BACKEND_ID"] =
  loadFacadeModule()["CLAUDE_CLI_STREAMING_BACKEND_ID"];
export const isClaudeCliProvider: FacadeModule["isClaudeCliProvider"] = ((...args) =>
  loadFacadeModule()["isClaudeCliProvider"](...args)) as FacadeModule["isClaudeCliProvider"];
export const isClaudeCliStreamingProvider: FacadeModule["isClaudeCliStreamingProvider"] = ((
  ...args
) =>
  loadFacadeModule()["isClaudeCliStreamingProvider"](
    ...args,
  )) as FacadeModule["isClaudeCliStreamingProvider"];
export const isClaudeCliFamilyProvider: FacadeModule["isClaudeCliFamilyProvider"] = ((...args) =>
  loadFacadeModule()["isClaudeCliFamilyProvider"](
    ...args,
  )) as FacadeModule["isClaudeCliFamilyProvider"];
