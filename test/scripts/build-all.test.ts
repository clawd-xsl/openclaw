import { describe, expect, it } from "vitest";
import { BUILD_ALL_STEPS, resolveBuildAllStep } from "../../scripts/build-all.mjs";

describe("resolveBuildAllStep", () => {
  it("routes pnpm steps through the npm_execpath pnpm runner on Windows", () => {
    const step = BUILD_ALL_STEPS.find((entry) => entry.label === "canvas:a2ui:bundle");
    expect(step).toBeTruthy();

    const result = resolveBuildAllStep(step, {
      platform: "win32",
      nodeExecPath: "C:\\Program Files\\nodejs\\node.exe",
      npmExecPath: "C:/Users/test/AppData/Local/pnpm/10.32.1/bin/pnpm.cjs",
      env: {},
    });

    expect(result).toEqual({
      command: "C:\\Program Files\\nodejs\\node.exe",
      args: ["C:/Users/test/AppData/Local/pnpm/10.32.1/bin/pnpm.cjs", "canvas:a2ui:bundle"],
      options: {
        stdio: "inherit",
        env: {},
        shell: false,
        windowsVerbatimArguments: undefined,
      },
    });
  });

  it("executes native pnpm binaries directly for pnpm build steps", () => {
    const step = BUILD_ALL_STEPS.find((entry) => entry.label === "canvas:a2ui:bundle");
    expect(step).toBeTruthy();

    const result = resolveBuildAllStep(step, {
      platform: "linux",
      nodeExecPath: "/usr/local/bin/node",
      npmExecPath:
        "/data/local/share/pnpm/.tools/@pnpm+linux-x64/10.32.1_tmp_22738/node_modules/@pnpm/linux-x64/pnpm",
      env: {},
    });

    expect(result).toEqual({
      command:
        "/data/local/share/pnpm/.tools/@pnpm+linux-x64/10.32.1_tmp_22738/node_modules/@pnpm/linux-x64/pnpm",
      args: ["canvas:a2ui:bundle"],
      options: {
        stdio: "inherit",
        env: {},
        shell: false,
        windowsVerbatimArguments: undefined,
      },
    });
  });

  it("keeps node steps on the current node binary", () => {
    const step = BUILD_ALL_STEPS.find((entry) => entry.label === "runtime-postbuild");
    expect(step).toBeTruthy();

    const result = resolveBuildAllStep(step, {
      nodeExecPath: "/custom/node",
      env: { FOO: "bar" },
    });

    expect(result).toEqual({
      command: "/custom/node",
      args: ["scripts/runtime-postbuild.mjs"],
      options: {
        stdio: "inherit",
        env: { FOO: "bar" },
      },
    });
  });

  it("adds heap headroom for plugin-sdk dts on Windows", () => {
    const step = BUILD_ALL_STEPS.find((entry) => entry.label === "build:plugin-sdk:dts");
    expect(step).toBeTruthy();

    const result = resolveBuildAllStep(step, {
      platform: "win32",
      nodeExecPath: "C:\\Program Files\\nodejs\\node.exe",
      npmExecPath: "C:/Users/test/AppData/Local/pnpm/10.32.1/bin/pnpm.cjs",
      env: { FOO: "bar" },
    });

    expect(result).toEqual({
      command: "C:\\Program Files\\nodejs\\node.exe",
      args: ["C:/Users/test/AppData/Local/pnpm/10.32.1/bin/pnpm.cjs", "build:plugin-sdk:dts"],
      options: {
        stdio: "inherit",
        env: {
          FOO: "bar",
          NODE_OPTIONS: "--max-old-space-size=4096",
        },
        shell: false,
        windowsVerbatimArguments: undefined,
      },
    });
  });
});
