export interface PtySize {
  cols: number;
  rows: number;
}

export class LatestClientSize {
  private readonly sizes = new Map<string, PtySize>();
  private recency: string[] = [];
  private applied: PtySize | null;

  constructor(initial: PtySize | null = null) {
    this.applied = initial;
  }

  resize(clientId: string, size: PtySize): PtySize | null {
    this.sizes.set(clientId, { cols: size.cols, rows: size.rows });
    if (!this.recency.includes(clientId)) this.recency.unshift(clientId);
    return this.apply();
  }

  input(clientId: string): PtySize | null {
    this.recency = this.recency.filter((id) => id !== clientId);
    this.recency.push(clientId);
    return this.apply();
  }

  remove(clientId: string): PtySize | null {
    this.sizes.delete(clientId);
    this.recency = this.recency.filter((id) => id !== clientId);
    return this.apply();
  }

  private apply(): PtySize | null {
    const latest = [...this.recency].reverse().find((id) => this.sizes.has(id));
    const size = latest === undefined ? undefined : this.sizes.get(latest);
    if (!size) return null;
    if (this.applied && this.applied.cols === size.cols && this.applied.rows === size.rows) return null;
    this.applied = size;
    return size;
  }
}
