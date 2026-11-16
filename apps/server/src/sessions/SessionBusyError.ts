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
