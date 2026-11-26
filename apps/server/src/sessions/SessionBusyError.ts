/** `SessionBusyError` detail while a harness update holds new turns back; the gate opens when the update ends. */
export const HARNESS_UPDATE_BUSY_DETAIL = "harness updating";

export class SessionBusyError extends Error {
  readonly code = "session-busy";

  constructor(
    readonly detail: string,
    message = `session busy (${detail})`
  ) {
    super(message);
    this.name = "SessionBusyError";
  }
}
