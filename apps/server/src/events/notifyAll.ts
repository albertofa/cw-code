export function notifyAll<A extends unknown[]>(listeners: ReadonlySet<(...args: A) => void>, label: string, ...args: A): void {
  for (const listener of listeners) {
    try {
      listener(...args);
    } catch (error) {
      console.warn(`${label} listener failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
