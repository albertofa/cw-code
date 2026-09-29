const IPC_PREFIX = /^Error invoking remote method '[^']*': (?:[A-Za-z]*Error: )?/;
const FILE_NOT_FOUND = /\bENOENT\b|^file not found: /;

export function ipcErrorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(IPC_PREFIX, "");
}

export function isFileNotFound(err: unknown): boolean {
  return FILE_NOT_FOUND.test(ipcErrorMessage(err));
}
