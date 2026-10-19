export type CommandDispatch = "prompt" | "native" | "app" | "terminal";

export type CommandKind = "command" | "skill";

export interface CommandOption {
  name: string;
  description: string;
  argumentHint?: string;
  dispatch: CommandDispatch;
  confirm?: string;
  /** Skills can also be mentioned anywhere in a prompt as `$name`. Omitted means "command". */
  kind?: CommandKind;
}

export interface CommandInvocation {
  name: string;
  args: string;
}
