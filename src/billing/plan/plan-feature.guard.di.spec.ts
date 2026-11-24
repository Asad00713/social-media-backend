import { Test } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import { PlanFeatureGuard } from './plan-feature.guard';
import { SubscriptionLookupService } from '../services/subscription-lookup.service';

/**
 * The guard resolves from a container, not just from `new`.
 *
 * `plan-feature.guard.spec.ts` constructs the class by hand, which proves the
 * logic and cannot prove the wiring: a guard missing from a module's providers
 * passes every hand-built test and then fails at the first request — or worse,
 * never runs at all. That is exactly how `workspacePurge` shipped dead.
 *
 * This builds a module with the same providers `BillingModule` declares for
 * it, so a constructor parameter added without a provider fails here.
 */
describe('PlanFeatureGuard wiring', () => {
  it('resolves with its dependencies injected', async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        PlanFeatureGuard,
        Reflector,
        {
          provide: SubscriptionLookupService,
          useValue: { findByWorkspaceId: jest.fn() },
        },
      ],
    }).compile();

    const guard = moduleRef.get(PlanFeatureGuard);
    expect(guard).toBeInstanceOf(PlanFeatureGuard);
    // A guard whose canActivate is missing would still resolve.
    expect(typeof guard.canActivate).toBe('function');
  });

  it('is listed in BillingModule providers and exports', () => {
    // Source-level, deliberately: importing BillingModule here would boot the
    // real Drizzle module and need a database. What can go wrong without a
    // database is the provider list, so that is what this reads.
    //
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'billing.module.ts'),
      'utf8',
    ) as string;

    expect(src).toContain('PlanFeatureGuard');
    // Exported too, or a controller in another module cannot use it with
    // @UseGuards even after importing BillingModule.
    const exportsBlock = src.slice(src.indexOf('exports: ['));
    expect(exportsBlock).toContain('PlanFeatureGuard');
  });
});
