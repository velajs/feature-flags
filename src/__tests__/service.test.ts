import { Logger, type RequestContext } from '@velajs/vela';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FeatureFlagDriverRegistry } from '../drivers/registry';
import { MemoryFlagDriver } from '../drivers/memory.driver';
import { FeatureFlagsService } from '../feature-flags.service';
import type { FeatureFlagDriver } from '../drivers/driver';
import type { FlagContext, FeatureFlagsOptions } from '../feature-flags.types';

function service(options: FeatureFlagsOptions): FeatureFlagsService {
  return new FeatureFlagsService(buildRegistry(options), options);
}

function buildRegistry(options: FeatureFlagsOptions): FeatureFlagDriverRegistry {
  const drivers = options.drivers && options.drivers.length > 0 ? options.drivers : [new MemoryFlagDriver()];
  return new FeatureFlagDriverRegistry(drivers, options.default);
}

/** A driver whose every evaluation rejects — exercises the never-throw seam. */
class ThrowingDriver implements FeatureFlagDriver {
  readonly name = 'throwing';
  getBoolean(): Promise<boolean> {
    return Promise.reject(new Error('binding down'));
  }
  getString(): Promise<string> {
    return Promise.reject(new Error('binding down'));
  }
  getNumber(): Promise<number> {
    return Promise.reject(new Error('binding down'));
  }
  getObject<T extends object>(): Promise<T> {
    return Promise.reject(new Error('binding down'));
  }
}

/** A driver that records the evaluation context it was handed. */
class RecordingDriver implements FeatureFlagDriver {
  readonly name = 'recording';
  lastContext: FlagContext | undefined;
  getBoolean(_k: string, fallback: boolean, ctx?: FlagContext): Promise<boolean> {
    this.lastContext = ctx;
    return Promise.resolve(fallback);
  }
  getString(_k: string, fallback: string, ctx?: FlagContext): Promise<string> {
    this.lastContext = ctx;
    return Promise.resolve(fallback);
  }
  getNumber(_k: string, fallback: number, ctx?: FlagContext): Promise<number> {
    this.lastContext = ctx;
    return Promise.resolve(fallback);
  }
  getObject<T extends object>(_k: string, fallback: T, ctx?: FlagContext): Promise<T> {
    this.lastContext = ctx;
    return Promise.resolve(fallback);
  }
}

const mockRequest = (id: string): RequestContext => ({ id }) as unknown as RequestContext;

describe('FeatureFlagsService', () => {
  describe('manifest defaults', () => {
    it('falls back to the declared manifest value when no default arg is given', async () => {
      const flags = service({
        drivers: [new MemoryFlagDriver()], // empty store → returns the fallback
        manifest: { 'new-checkout': true, layout: 'v2', limit: 42 },
      });
      expect(await flags.getBooleanValue('new-checkout')).toBe(true);
      expect(await flags.getStringValue('layout')).toBe('v2');
      expect(await flags.getNumberValue('limit')).toBe(42);
    });

    it('an explicit default argument wins over the manifest', async () => {
      const flags = service({ manifest: { 'new-checkout': true } });
      expect(await flags.getBooleanValue('new-checkout', false)).toBe(false);
    });

    it('a stored driver value wins over the manifest default', async () => {
      const flags = service({
        drivers: [new MemoryFlagDriver({ values: { 'new-checkout': false } })],
        manifest: { 'new-checkout': true },
      });
      expect(await flags.getBooleanValue('new-checkout')).toBe(false);
    });
  });

  describe('never-throw', () => {
    beforeEach(() => Logger.resetWriter());
    afterEach(() => Logger.resetWriter());

    it('absorbs a throwing driver into the fallback and logs a warning', async () => {
      const warnings: string[] = [];
      Logger.setWriter((level, line) => {
        if (level === 'WARN') warnings.push(line);
      });

      const flags = service({ drivers: [new ThrowingDriver()], manifest: { 'new-checkout': true } });

      // fallback = manifest default (true), despite the driver rejecting
      expect(await flags.getBooleanValue('new-checkout')).toBe(true);
      // explicit fallback also honored
      expect(await flags.getStringValue('layout', 'safe')).toBe('safe');
      expect(warnings.length).toBeGreaterThanOrEqual(2);
      expect(warnings.some((w) => w.includes('new-checkout') && w.includes('throwing'))).toBe(true);
    });

    it('details synthesize an ERROR reason on failure', async () => {
      Logger.setWriter(() => {});
      const flags = service({ drivers: [new ThrowingDriver()] });
      const details = await flags.getBooleanDetails('x', false);
      expect(details).toMatchObject({ flagKey: 'x', value: false, reason: 'ERROR' });
      expect(details.errorMessage).toContain('binding down');
    });

    it('details synthesize a STATIC reason on success', async () => {
      const flags = service({ drivers: [new MemoryFlagDriver({ values: { x: true } })] });
      expect(await flags.getBooleanDetails('x', false)).toMatchObject({
        flagKey: 'x',
        value: true,
        reason: 'STATIC',
      });
    });
  });

  describe('use() immutability', () => {
    it('returns a new instance bound to another driver, leaving the original untouched', async () => {
      const primary = new MemoryFlagDriver({ name: 'primary', values: { flag: true } });
      const experiments = new MemoryFlagDriver({ name: 'experiments', values: { flag: false } });
      const flags = service({ drivers: [primary, experiments], default: 'primary' });

      const switched = flags.use('experiments');
      expect(switched).not.toBe(flags);
      expect(flags.driverName).toBe('primary');
      expect(switched.driverName).toBe('experiments');
      expect(await flags.getBooleanValue('flag')).toBe(true);
      expect(await switched.getBooleanValue('flag')).toBe(false);
    });

    it('returns the same instance when switching to the current driver', () => {
      const flags = service({ drivers: [new MemoryFlagDriver({ name: 'primary' })] });
      expect(flags.use('primary')).toBe(flags);
    });

    it('throws for an unknown driver name', () => {
      const flags = service({ drivers: [new MemoryFlagDriver({ name: 'primary' })] });
      expect(() => flags.use('nope')).toThrow(/not registered/);
    });
  });

  describe('all()', () => {
    it('evaluates the whole manifest, choosing the method from each declared type', async () => {
      const flags = service({
        drivers: [new MemoryFlagDriver({ values: { bool: false, num: 9 } })],
        manifest: { bool: true, num: 1, str: 'default', obj: { k: 1 } },
      });
      expect(await flags.all()).toEqual({
        bool: false, // from driver
        num: 9, // from driver
        str: 'default', // manifest default (driver has no value)
        obj: { k: 1 },
      });
    });

    it('returns manifest defaults when the context resolver throws', async () => {
      Logger.setWriter(() => {});
      const flags = service({
        drivers: [new MemoryFlagDriver()],
        manifest: { a: true, b: 'x' },
        context: () => {
          throw new Error('ctx boom');
        },
      });
      const bound = flags.forRequest(mockRequest('r'));
      expect(await bound.all()).toEqual({ a: true, b: 'x' });
      Logger.resetWriter();
    });
  });

  describe('context merge', () => {
    it('merges options.context(requestCtx) into every evaluation, per-call overriding', async () => {
      const recording = new RecordingDriver();
      const flags = service({
        drivers: [recording],
        context: (ctx) => ({ userId: ctx.id, plan: 'free' }),
      }).forRequest(mockRequest('user-42'));

      await flags.getBooleanValue('x');
      expect(recording.lastContext).toEqual({ userId: 'user-42', plan: 'free' });

      await flags.getBooleanValue('x', false, { plan: 'pro', extra: 1 });
      expect(recording.lastContext).toEqual({ userId: 'user-42', plan: 'pro', extra: 1 });
    });

    it('skips context when no request is bound (queue/cron/global scope)', async () => {
      const recording = new RecordingDriver();
      const ctxSpy = vi.fn(() => ({ userId: 'x' }));
      const flags = service({ drivers: [recording], context: ctxSpy });

      await flags.getBooleanValue('x');
      expect(ctxSpy).not.toHaveBeenCalled();
      expect(recording.lastContext).toBeUndefined();
    });
  });
});
