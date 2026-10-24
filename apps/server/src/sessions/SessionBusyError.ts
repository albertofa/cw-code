export class SessionBusyError extends Error {
  readonly code = "session-busy";

  constructor(detail: string) {
    super(`session busy (${detail})`);
    this.name = "SessionBusyError";
  }
}
