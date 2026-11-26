export interface RefCounter<T> {
  acquire(key: string, value: T): boolean;
  release(key: string): boolean;
  values(): T[];
  readonly size: number;
}

export function createRefCounter<T>(): RefCounter<T> {
  const entries = new Map<string, { value: T; count: number }>();
  return {
    acquire(key, value) {
      const entry = entries.get(key);
      if (entry) {
        entry.count += 1;
        return false;
      }
      entries.set(key, { value, count: 1 });
      return true;
    },
    release(key) {
      const entry = entries.get(key);
      if (!entry) return false;
      entry.count -= 1;
      if (entry.count > 0) return false;
      entries.delete(key);
      return true;
    },
    values() {
      return [...entries.values()].map((entry) => entry.value);
    },
    get size() {
      return entries.size;
    }
  };
}
