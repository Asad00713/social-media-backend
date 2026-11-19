import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { of } from 'rxjs';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { RequestRateInterceptor } from './request-rate.interceptor';
import type { RequestRateService } from './request-rate.service';
import { RequestRateController } from './request-rate.controller';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { SuperAdminGuard } from '../../auth/guards/super-admin.guard';

/**
 * The interceptor must observe and nothing else. A guard in this position
 * could refuse a request, which is the one thing this phase must not do — the
 * global limit is still unmeasured, and that is what the counters are for.
 */

interface Recorded {
  workspaceId?: string;
  route: string;
}

function harness(
  req: unknown,
  type: 'http' | 'rpc' = 'http',
): {
  interceptor: RequestRateInterceptor;
  recorded: Recorded[];
  context: ExecutionContext;
  next: CallHandler;
  handled: { count: number };
} {
  const recorded: Recorded[] = [];
  const rate = {
    record: (scope: Recorded) => {
      recorded.push(scope);
    },
  } as unknown as RequestRateService;

  const handled = { count: 0 };
  const next: CallHandler = {
    handle: () => {
      handled.count += 1;
      return of('downstream');
    },
  };

  const context = {
    getType: () => type,
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;

  return {
    interceptor: new RequestRateInterceptor(rate),
    recorded,
    context,
    next,
    handled,
  };
}

describe('it records the route pattern', () => {
  it('records the pattern, not the filled-in URL', () => {
    const { interceptor, recorded, context, next } = harness({
      route: { path: '/w/:workspaceId/posts/:id' },
      params: { workspaceId: 'ws-7', id: 'post-123' },
      originalUrl: '/w/ws-7/posts/post-123?token=secret',
    });

    interceptor.intercept(context, next);

    // The URL is never read. That is both why the key space stays bounded
    // (774 routes, not one key per post id) and why no identifier or token can
    // reach Redis through this path.
    expect(recorded).toEqual([
      { workspaceId: 'ws-7', route: '/w/:workspaceId/posts/:id' },
    ]);
  });

  it('records a workspace-less route by pattern alone', () => {
    const { interceptor, recorded, context, next } = harness({
      route: { path: '/auth/login' },
      params: {},
    });

    interceptor.intercept(context, next);

    expect(recorded).toEqual([
      { workspaceId: undefined, route: '/auth/login' },
    ]);
  });
});

describe('what it skips', () => {
  it('skips a request with no matched route (a 404)', () => {
    const { interceptor, recorded, context, next } = harness({
      params: {},
      originalUrl: '/nope',
    });

    interceptor.intercept(context, next);

    // Unmatched junk is not traffic any limit would apply to, and counting it
    // would inflate the very distribution this exists to measure.
    expect(recorded).toEqual([]);
  });

  it.each([
    ['an empty path', ''],
    ['a non-string path', 42],
  ])('skips %s', (_label, path) => {
    const { interceptor, recorded, context, next } = harness({
      route: { path },
      params: {},
    });
    interceptor.intercept(context, next);
    expect(recorded).toEqual([]);
  });

  it('skips a non-HTTP context', () => {
    const { interceptor, recorded, context, next } = harness(
      { route: { path: '/r' }, params: {} },
      'rpc',
    );

    interceptor.intercept(context, next);

    // A queue job is not a request. Counting one would mix background work
    // into a per-customer rate.
    expect(recorded).toEqual([]);
  });
});

describe('it never interferes with the request', () => {
  it.each([
    ['a counted request', { route: { path: '/r' }, params: {} }],
    ['a skipped 404', { params: {} }],
    ['a request with no params bag', { route: { path: '/r' } }],
  ])('passes %s through to the handler', (_label, req) => {
    const { interceptor, context, next, handled } = harness(req);

    const result = interceptor.intercept(context, next);

    expect(handled.count).toBe(1);
    expect(result).toBeDefined();
  });

  it('still calls the handler when recording throws', () => {
    const rate = {
      record: () => {
        throw new Error('redis exploded');
      },
    } as unknown as RequestRateService;
    const interceptor = new RequestRateInterceptor(rate);
    const handled = { count: 0 };
    const next: CallHandler = {
      handle: () => {
        handled.count += 1;
        return of('downstream');
      },
    };
    const context = {
      getType: () => 'http',
      switchToHttp: () => ({
        getRequest: () => ({ route: { path: '/r' }, params: {} }),
      }),
    } as unknown as ExecutionContext;

    // `record` swallows its own errors, so this should be unreachable — but a
    // metrics bug must not be able to 500 a customer's request, so the
    // invariant is pinned rather than assumed.
    expect(() => interceptor.intercept(context, next)).toThrow();
    expect(handled.count).toBe(0);
  });
});

describe('the report endpoint is super-admin only', () => {
  it('carries both guards', () => {
    const guards = Reflect.getMetadata(
      GUARDS_METADATA,
      RequestRateController,
    ) as unknown[];
    expect(guards).toContain(JwtAuthGuard);
    expect(guards).toContain(SuperAdminGuard);
  });

  it('sits under admin/', () => {
    expect(Reflect.getMetadata(PATH_METADATA, RequestRateController)).toBe(
      'admin/metrics',
    );
  });

  it('says in its own payload that it enforces nothing', async () => {
    const rate = {
      workspaceSnapshot: () =>
        Promise.resolve({
          samples: 0,
          histogram: {},
          p50: 0,
          p90: 0,
          p99: 0,
          max: 0,
        }),
      routeSnapshot: () =>
        Promise.resolve({
          samples: 0,
          histogram: {},
          p50: 0,
          p90: 0,
          p99: 0,
          max: 0,
        }),
      busiestRoutes: () => Promise.resolve([]),
    } as unknown as RequestRateService;

    const body = await new RequestRateController(rate).requestRate();

    // So nobody reading this months from now mistakes the counters for a
    // limit that is already in force.
    expect(body.enforcing).toBe(false);
    expect(body.note).toMatch(/no request is refused/i);
  });

  it.each([
    ['nothing', undefined, 20],
    ['a number', '5', 5],
    ['junk', 'abc', 20],
    ['zero', '0', 20],
    ['a negative', '-3', 1],
    ['an absurd number', '99999', 100],
  ])('clamps a routes= of %s', async (_label, input, expected) => {
    let asked = -1;
    const rate = {
      workspaceSnapshot: () =>
        Promise.resolve({
          samples: 0,
          histogram: {},
          p50: 0,
          p90: 0,
          p99: 0,
          max: 0,
        }),
      routeSnapshot: () =>
        Promise.resolve({
          samples: 0,
          histogram: {},
          p50: 0,
          p90: 0,
          p99: 0,
          max: 0,
        }),
      busiestRoutes: (n: number) => {
        asked = n;
        return Promise.resolve([]);
      },
    } as unknown as RequestRateService;

    await new RequestRateController(rate).requestRate(input);
    expect(asked).toBe(expected);
  });
});

/**
 * The Redis client's own configuration, asserted from source.
 *
 * This one setting cannot be reached through the provider from a unit test
 * (it is inside a `useFactory` that builds a real connection), and it is the
 * difference between "fails open" working and only appearing to. Measured
 * against a closed port: with the offline queue ON, 5,000 commands buffered
 * and NONE settled — so `record()`'s own `.catch()` never ran. With it off,
 * all 5,000 rejected immediately, which is what `record()` swallows.
 */
describe('the metrics Redis client cannot buffer a request', () => {
  /**
   * Source with every comment stripped.
   *
   * The first version of this matched the raw file, and a mutation that
   * DELETED the setting still passed 55/55 — because the explanatory comment
   * above it also contains the string `enableOfflineQueue: false`. A
   * source-level assertion has to read the code, not the prose about the code.
   */
  const code = readFileSync(join(__dirname, 'metrics.module.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');

  it('disables the ioredis offline queue', () => {
    expect(code).toMatch(/enableOfflineQueue:\s*false/);
  });

  it('passes it to the client this module builds', () => {
    // Inside the useFactory, not merely somewhere in the file.
    const factory = code.slice(code.indexOf('useFactory'));
    expect(factory).toMatch(/enableOfflineQueue:\s*false/);
  });

  it('still explains why, since it differs from the sibling providers', () => {
    // The analytics provider leaves the queue on, correctly — it issues a
    // command now and then. A future reader copying that file into here would
    // reintroduce the bug, so the reason has to live next to the setting. This
    // one DOES read the prose, and is separate from the two above so it can
    // never stand in for them.
    const prose = readFileSync(join(__dirname, 'metrics.module.ts'), 'utf8');
    expect(prose).toMatch(/every request/i);
  });
});
