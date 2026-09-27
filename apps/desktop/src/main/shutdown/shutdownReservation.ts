export const SHUTDOWN_RESERVED_MESSAGE = "cw-code is preparing to restart; try again after it finishes or is cancelled";

export function shutdownReservedError(): Error {
  return new Error(SHUTDOWN_RESERVED_MESSAGE);
}
