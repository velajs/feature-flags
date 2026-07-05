import type { FeatureFlagDriver } from './driver';
import type { FlagContext, FlagManifest, FlagValue } from '../feature-flags.types';

export interface MemoryFlagDriverOptions {
  /** Driver name used for `use(name)` / the default-driver selection. Default `"memory"`. */
  name?: string;
  /** Initial flag values. */
  values?: FlagManifest;
}

/**
 * In-memory {@link FeatureFlagDriver}: the default driver shipped in-package
 * and the test fake in one. Reads from an internal `Map` seeded from options
 * or mutated with {@link set}/{@link reset} — the memory driver ignores the
 * evaluation context (it does no targeting). An unknown key returns the
 * caller's `fallback`, exactly like a remote driver that can't resolve it.
 */
export class MemoryFlagDriver implements FeatureFlagDriver {
  readonly name: string;
  private readonly store: Map<string, FlagValue>;

  constructor(options: MemoryFlagDriverOptions = {}) {
    this.name = options.name ?? 'memory';
    this.store = new Map(Object.entries(options.values ?? {}));
  }

  /** Set a flag value. Chainable. */
  set(key: string, value: FlagValue): this {
    this.store.set(key, value);
    return this;
  }

  /** Remove a flag (subsequent reads return the caller's fallback). Chainable. */
  delete(key: string): this {
    this.store.delete(key);
    return this;
  }

  /** True when `key` has a stored value. */
  has(key: string): boolean {
    return this.store.has(key);
  }

  /** Clear all flags, then optionally seed a fresh set. Chainable. */
  reset(values?: FlagManifest): this {
    this.store.clear();
    if (values) {
      for (const [key, value] of Object.entries(values)) this.store.set(key, value);
    }
    return this;
  }

  getBoolean(key: string, fallback: boolean, _ctx?: FlagContext): Promise<boolean> {
    return Promise.resolve(this.read(key, fallback));
  }

  getString(key: string, fallback: string, _ctx?: FlagContext): Promise<string> {
    return Promise.resolve(this.read(key, fallback));
  }

  getNumber(key: string, fallback: number, _ctx?: FlagContext): Promise<number> {
    return Promise.resolve(this.read(key, fallback));
  }

  getObject<T extends object>(key: string, fallback: T, _ctx?: FlagContext): Promise<T> {
    return Promise.resolve(this.read(key, fallback));
  }

  private read<T extends FlagValue>(key: string, fallback: T): T {
    return this.store.has(key) ? (this.store.get(key) as T) : fallback;
  }
}

/** Convenience factory for {@link MemoryFlagDriver}. */
export function memoryFlagDriver(options?: MemoryFlagDriverOptions): MemoryFlagDriver {
  return new MemoryFlagDriver(options);
}
