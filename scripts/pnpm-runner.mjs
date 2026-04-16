import { spawn } from "node:child_process";
import { buildCmdExeCommandLine } from "./windows-cmd-helpers.mjs";

function resolvePnpmExecPathKind(value) {
  const basename = value.replaceAll("\\", "/").split("/").at(-1)?.toLowerCase() ?? "";
  if (!/^pnpm(?:-cli)?(?:\.(?:js|cjs|mjs|cmd|exe))?$/.test(basename)) {
    return null;
  }
  const extension = basename.includes(".") ? `.${basename.split(".").at(-1)}` : "";
  if (extension === ".js" || extension === ".cjs" || extension === ".mjs") {
    return "node";
  }
  if (extension === ".cmd") {
    return "cmd";
  }
  return "native";
}

export function resolvePnpmRunner(params = {}) {
  const pnpmArgs = params.pnpmArgs ?? [];
  const nodeArgs = params.nodeArgs ?? [];
  const npmExecPath = params.npmExecPath ?? process.env.npm_execpath;
  const nodeExecPath = params.nodeExecPath ?? process.execPath;
  const platform = params.platform ?? process.platform;
  const comSpec = params.comSpec ?? process.env.ComSpec ?? "cmd.exe";
  const pnpmExecPathKind =
    typeof npmExecPath === "string" && npmExecPath.length > 0
      ? resolvePnpmExecPathKind(npmExecPath)
      : null;

  if (pnpmExecPathKind === "node") {
    return {
      command: nodeExecPath,
      args: [...nodeArgs, npmExecPath, ...pnpmArgs],
      shell: false,
    };
  }

  if (pnpmExecPathKind === "native") {
    return {
      command: npmExecPath,
      args: pnpmArgs,
      shell: false,
    };
  }

  if (pnpmExecPathKind === "cmd" && platform === "win32") {
    return {
      command: comSpec,
      args: ["/d", "/s", "/c", buildCmdExeCommandLine(npmExecPath, pnpmArgs)],
      shell: false,
      windowsVerbatimArguments: true,
    };
  }

  if (platform === "win32") {
    return {
      command: comSpec,
      args: ["/d", "/s", "/c", buildCmdExeCommandLine("pnpm.cmd", pnpmArgs)],
      shell: false,
      windowsVerbatimArguments: true,
    };
  }

  return {
    command: "pnpm",
    args: pnpmArgs,
    shell: false,
  };
}

export function createPnpmRunnerSpawnSpec(params = {}) {
  const runner = resolvePnpmRunner(params);
  return {
    command: runner.command,
    args: runner.args,
    options: {
      cwd: params.cwd,
      detached: params.detached,
      stdio: params.stdio ?? "inherit",
      env: params.env ?? runner.env ?? process.env,
      shell: runner.shell,
      windowsVerbatimArguments: runner.windowsVerbatimArguments,
    },
  };
}

export function spawnPnpmRunner(params = {}) {
  const spawnSpec = createPnpmRunnerSpawnSpec(params);
  return spawn(spawnSpec.command, spawnSpec.args, spawnSpec.options);
}
