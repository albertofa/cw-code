const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

function escapeCmdMeta(value: string): string {
  return value.replace(CMD_META, "^$1");
}

// Escaped twice: cmd.exe parses the line once and the batch file parses %* again.
export function quoteBatchArg(arg: string): string {
  const escaped = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1");
  return escapeCmdMeta(escapeCmdMeta(`"${escaped}"`));
}

export function batchCommandLine(batchFile: string, args: readonly string[]): string {
  return [`"${batchFile}"`, ...args.map(quoteBatchArg)].join(" ");
}

export function cmdSwitchLine(cmdSwitch: "/c" | "/k", batchFile: string, args: readonly string[]): string {
  return `/s ${cmdSwitch} "${batchCommandLine(batchFile, args)}"`;
}
