export class ActivityNotifier {
  private readonly listeners = new Set<() => void>();

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (err) {
        console.warn(`driver activity listener failed: ${(err as Error).message}`);
      }
    }
  }
}
