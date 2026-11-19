import { WorkerHost } from '@nestjs/bullmq';
import { CronRoleGate } from './cron-role.gate';
import { QueueRoleGate } from './queue-role.gate';

/** A processor the gate can discover, shaped like the real ones. */
class FakeHost extends WorkerHost {
  paused = 0;
  closed = 0;
  private readonly fake = {
    pause: async (_doNotWaitActive?: boolean) => {
      this.paused += 1;
    },
    close: async () => {
      this.closed += 1;
    },
  };
  constructor(private readonly broken = false) {
    super();
  }
  get worker(): any {
    if (this.broken) throw new Error('never started');
    return this.fake;
  }
  async process(): Promise<void> {}
}

const discoveryOf = (instances: unknown[]) =>
  ({ getProviders: () => instances.map((instance) => ({ instance })) }) as any;

const cronJob = () => {
  let running = true;
  return {
    stop: () => {
      running = false;
    },
    get running() {
      return running;
    },
  };
};

const registryOf = (jobs: Map<string, any>) =>
  ({ getCronJobs: () => jobs }) as any;

describe('QueueRoleGate', () => {
  const withRole = async (role: string, hosts: unknown[]) => {
    const prev = process.env.ROLE;
    process.env.ROLE = role;
    try {
      await new QueueRoleGate(discoveryOf(hosts)).onApplicationBootstrap();
    } finally {
      if (prev === undefined) delete process.env.ROLE;
      else process.env.ROLE = prev;
    }
  };

  it('pauses every worker on a web process', async () => {
    const a = new FakeHost();
    const b = new FakeHost();
    await withRole('web', [a, b, { notAHost: true }]);
    expect(a.paused).toBe(1);
    expect(b.paused).toBe(1);
  });

  it('leaves workers running on a worker process', async () => {
    const a = new FakeHost();
    await withRole('worker', [a]);
    expect(a.paused).toBe(0);
  });

  // Today's behaviour must survive an unset variable.
  it('leaves workers running when ROLE is unset', async () => {
    const a = new FakeHost();
    const prev = process.env.ROLE;
    delete process.env.ROLE;
    try {
      await new QueueRoleGate(discoveryOf([a])).onApplicationBootstrap();
    } finally {
      if (prev !== undefined) process.env.ROLE = prev;
    }
    expect(a.paused).toBe(0);
  });

  // pause(), never close(): close is terminal and the shutdown drain needs
  // the instance to still be there.
  it('pauses rather than closes', async () => {
    const a = new FakeHost();
    await withRole('web', [a]);
    expect(a.closed).toBe(0);
  });

  it('skips a processor that was never started', async () => {
    const broken = new FakeHost(true);
    const ok = new FakeHost();
    await expect(withRole('web', [broken, ok])).resolves.toBeUndefined();
    expect(ok.paused).toBe(1);
  });
});

describe('CronRoleGate', () => {
  const withRole = (role: string, jobs: Map<string, any>) => {
    const prev = process.env.ROLE;
    process.env.ROLE = role;
    try {
      new CronRoleGate(registryOf(jobs)).onApplicationBootstrap();
    } finally {
      if (prev === undefined) delete process.env.ROLE;
      else process.env.ROLE = prev;
    }
  };

  it('stops every cron on a web process', () => {
    const a = cronJob();
    const b = cronJob();
    withRole('web', new Map([['a', a], ['b', b]]));
    expect(a.running).toBe(false);
    expect(b.running).toBe(false);
  });

  it('leaves crons running on a worker process', () => {
    const a = cronJob();
    withRole('worker', new Map([['a', a]]));
    expect(a.running).toBe(true);
  });

  it('leaves crons running when ROLE is unset', () => {
    const a = cronJob();
    const prev = process.env.ROLE;
    delete process.env.ROLE;
    try {
      new CronRoleGate(registryOf(new Map([['a', a]]))).onApplicationBootstrap();
    } finally {
      if (prev !== undefined) process.env.ROLE = prev;
    }
    expect(a.running).toBe(true);
  });

  it('keeps going when one cron refuses to stop', () => {
    const bad = {
      stop: () => {
        throw new Error('nope');
      },
    };
    const good = cronJob();
    expect(() =>
      withRole('web', new Map<string, any>([['bad', bad], ['good', good]])),
    ).not.toThrow();
    expect(good.running).toBe(false);
  });
});
