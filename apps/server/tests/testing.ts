import { vi } from "bun:test";

declare const Bun: { gc(force: boolean): void };

const stubbedGlobals = new Map<string, PropertyDescriptor | undefined>();
const stubbedEnv = new Map<string, string | undefined>();

export function stubGlobal(name: string, value: unknown): void {
  if (!stubbedGlobals.has(name)) stubbedGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { value, writable: true, configurable: true, enumerable: true });
}

export function unstubAllGlobals(): void {
  for (const [name, descriptor] of stubbedGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  stubbedGlobals.clear();
}

export function stubEnv(name: string, value: string): void {
  if (!stubbedEnv.has(name)) stubbedEnv.set(name, process.env[name]);
  process.env[name] = value;
}

export function unstubAllEnvs(): void {
  for (const [name, value] of stubbedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  stubbedEnv.clear();
}

export function releaseSqliteFiles(): void {
  Bun.gc(true);
}

function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export async function advanceTimersByTimeAsync(ms: number): Promise<void> {
  const target = Date.now() + ms;
  await settle();
  let reached = ms <= 0;
  let sentinel: ReturnType<typeof setTimeout> | null = null;
  while (!reached) {
    sentinel ??= setTimeout(() => {
      reached = true;
    }, target - Date.now());
    vi.advanceTimersToNextTimer();
    if (!reached && Date.now() < target) {
      clearTimeout(sentinel);
      sentinel = null;
    }
    await settle();
  }
}

export async function waitFor<T>(
  callback: () => T | Promise<T>,
  { timeout = 1000, interval = 50 }: { timeout?: number; interval?: number } = {}
): Promise<T> {
  const attempts = Math.max(1, Math.ceil(timeout / interval));
  for (let attempt = 1; ; attempt++) {
    try {
      return await callback();
    } catch (error) {
      if (attempt >= attempts) throw error;
      if (vi.isFakeTimers()) await advanceTimersByTimeAsync(interval);
      else await new Promise((resolve) => setTimeout(resolve, interval));
    }
  }
}
