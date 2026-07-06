const CLAUDE_EXECUTABLE_NAMES = new Set(["claude", "claude.exe", "claude.cmd", "claude.bat"]);

export function isClaudePrintModeArg(arg: string): boolean {
  return (
    (arg.startsWith("-p") && !arg.startsWith("--")) ||
    arg === "--print" ||
    arg.startsWith("--print=")
  );
}

function isClaudeExecutable(command: string): boolean {
  const normalized = command.replaceAll("\\", "/");
  const basename = normalized.slice(normalized.lastIndexOf("/") + 1).toLowerCase();
  return CLAUDE_EXECUTABLE_NAMES.has(basename);
}

export function stripClaudePrintModeArgs(args: readonly string[]): string[] {
  return args.filter((arg) => !isClaudePrintModeArg(arg));
}

export function stripClaudePrintModeArgsForCommand(
  command: string,
  args: readonly string[],
): string[] {
  return isClaudeExecutable(command) ? stripClaudePrintModeArgs(args) : Array.from(args);
}
