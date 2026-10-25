export type ChangeSource = (onChange: () => void) => () => void;

export class ShutdownPublisher {
  private queued = false;
  private disposed = false;

  constructor(private readonly publish: () => void) {}

  schedule(): void {
    if (this.queued || this.disposed) return;
    this.queued = true;
    queueMicrotask(() => {
      this.queued = false;
      if (this.disposed) return;
      try {
        this.publish();
      } catch (err) {
        console.warn(`[shutdown] could not publish the assessment: ${(err as Error).message}`);
      }
    });
  }

  watch(...sources: ChangeSource[]): () => void {
    const stops = sources.map((source) => source(() => this.schedule()));
    this.schedule();
    return () => {
      for (const stop of stops) stop();
    };
  }

  dispose(): void {
    this.disposed = true;
  }
}
