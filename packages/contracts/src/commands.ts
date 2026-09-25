export type CommandDispatch = "prompt" | "native" | "app" | "terminal";

export interface CommandOption {
  name: string;
  description: string;
  argumentHint?: string;
  dispatch: CommandDispatch;
  confirm?: string;
}

export interface CommandInvocation {
  name: string;
  args: string;
}
