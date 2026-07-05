import { Controller, Get, MetadataRegistry, UseGuards } from '@velajs/vela';
import { Test } from '@velajs/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FeatureFlag, FeatureFlagGuard, FeatureFlagsModule, memoryFlagDriver } from '../index';
import type { MemoryFlagDriver } from '../index';

/** Fresh decorated controller per test (metadata is re-applied on each build). */
function guardedController() {
  @Controller('/checkout')
  @UseGuards(FeatureFlagGuard)
  class CheckoutController {
    @Get('/plain')
    plain() {
      return { ok: true };
    }

    @FeatureFlag('new-checkout')
    @Get('/v2')
    v2() {
      return { checkout: 'v2' };
    }

    @FeatureFlag('beta', { onDisabled: 'forbidden' })
    @Get('/beta')
    beta() {
      return { beta: true };
    }
  }
  return CheckoutController;
}

async function appWith(
  controller: ReturnType<typeof guardedController>,
  driver: MemoryFlagDriver,
  moduleOpts: { isGlobal?: boolean } = {},
) {
  const moduleRef = await Test.createTestingModule({
    controllers: [controller],
    imports: [FeatureFlagsModule.forRoot({ drivers: [driver], ...moduleOpts })],
  }).compile();
  const app = await moduleRef.createApplication();
  return app.getHonoApp();
}

describe('FeatureFlagGuard (integration)', () => {
  beforeEach(() => MetadataRegistry.clear());
  afterEach(() => MetadataRegistry.clear());

  it('hides a route behind a disabled flag (404)', async () => {
    const driver = memoryFlagDriver({ values: { 'new-checkout': false } });
    const app = await appWith(guardedController(), driver);
    const res = await app.request('/checkout/v2');
    expect(res.status).toBe(404);
  });

  it('serves the route when the flag is enabled (200)', async () => {
    const driver = memoryFlagDriver({ values: { 'new-checkout': true } });
    const app = await appWith(guardedController(), driver);
    const res = await app.request('/checkout/v2');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ checkout: 'v2' });
  });

  it('lets un-gated routes through untouched', async () => {
    const driver = memoryFlagDriver({ values: { 'new-checkout': false } });
    const app = await appWith(guardedController(), driver);
    const res = await app.request('/checkout/plain');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('returns 403 when the decorator opts into forbidden-on-disabled', async () => {
    const driver = memoryFlagDriver({ values: { beta: false } });
    const app = await appWith(guardedController(), driver);
    const res = await app.request('/checkout/beta');
    expect(res.status).toBe(403);
  });

  it('re-evaluates per request (a flag flip is picked up without rebuilding the app)', async () => {
    const driver = memoryFlagDriver({ values: { 'new-checkout': false } });
    const app = await appWith(guardedController(), driver);

    expect((await app.request('/checkout/v2')).status).toBe(404);
    driver.set('new-checkout', true);
    expect((await app.request('/checkout/v2')).status).toBe(200);
  });

  it('gates app-wide via the isGlobal APP_GUARD (no @UseGuards on the controller)', async () => {
    @Controller('/promo')
    class PromoController {
      @FeatureFlag('promo')
      @Get('/show')
      show() {
        return { promo: true };
      }
    }
    const driver = memoryFlagDriver({ values: { promo: false } });
    const moduleRef = await Test.createTestingModule({
      controllers: [PromoController],
      imports: [FeatureFlagsModule.forRoot({ drivers: [driver], isGlobal: true })],
    }).compile();
    const app = (await moduleRef.createApplication()).getHonoApp();

    expect((await app.request('/promo/show')).status).toBe(404);
    driver.set('promo', true);
    expect((await app.request('/promo/show')).status).toBe(200);
  });
});
