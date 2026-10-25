import type { TopicOp, TopicPatch, TopicSnapshot } from "@cw-code/contracts";

type Entries = Record<string, unknown>;

function sameJson(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

export class TopicStore<D extends Record<string, unknown>> {
  private data: Entries;
  private currentRev: number;
  private pending: TopicOp[] | null = null;

  constructor(
    readonly topic: string,
    initial: D,
    startRev: number,
    private readonly publish: (patch: TopicPatch) => void
  ) {
    this.data = { ...initial };
    this.currentRev = startRev - 1;
  }

  get rev(): number {
    return this.currentRev;
  }

  snapshot(): TopicSnapshot<D> {
    return { rev: this.currentRev, data: { ...this.data } as D };
  }

  get<K extends keyof D & string>(key: K): D[K] | undefined {
    return this.data[key] as D[K] | undefined;
  }

  keys(prefix = ""): string[] {
    return Object.keys(this.data).filter((key) => key.startsWith(prefix));
  }

  upsert<K extends keyof D & string>(key: K, value: D[K]): void {
    if (Object.hasOwn(this.data, key) && sameJson(this.data[key], value)) return;
    this.data[key] = value;
    this.emit({ op: "upsert", key, value });
  }

  remove(key: keyof D & string): void {
    if (!Object.hasOwn(this.data, key)) return;
    delete this.data[key];
    this.emit({ op: "remove", key });
  }

  append(key: keyof D & string, field: string, text: string): void {
    const entry = this.data[key];
    if (typeof entry !== "object" || entry === null) throw new Error(`cannot append to missing entry '${key}' of topic '${this.topic}'`);
    const current = (entry as Entries)[field];
    if (typeof current !== "string") throw new Error(`field '${field}' of entry '${key}' in topic '${this.topic}' is not a string`);
    this.data[key] = { ...entry, [field]: current + text };
    this.emit({ op: "append", key, field, text });
  }

  replace(data: D): void {
    this.data = { ...data };
    this.emit({ op: "replace", value: { ...data } });
  }

  sync(next: D): void {
    this.batch(() => {
      for (const key of Object.keys(this.data)) {
        if (!Object.hasOwn(next, key)) this.remove(key);
      }
      for (const [key, value] of Object.entries(next)) this.upsert(key, value as D[keyof D & string]);
    });
  }

  batch(run: () => void): void {
    if (this.pending) {
      run();
      return;
    }
    this.pending = [];
    try {
      run();
    } finally {
      const ops = this.pending;
      this.pending = null;
      this.flush(ops);
    }
  }

  private emit(op: TopicOp): void {
    if (this.pending) this.pending.push(op);
    else this.flush([op]);
  }

  private flush(ops: TopicOp[]): void {
    if (ops.length === 0) return;
    this.currentRev += 1;
    this.publish({ topic: this.topic, rev: this.currentRev, ops });
  }
}
