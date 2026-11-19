import {
  DEFAULT_PROCESS_ROLE,
  PROCESS_ROLE_ENV,
  parseProcessRole,
  processRole,
  runsCrons,
  runsQueues,
  servesHttp,
} from './process-role';

describe('process role', () => {
  describe('parsing', () => {
    it.each(['all', 'web', 'worker'] as const)('accepts %s', (v) => {
      expect(parseProcessRole(v)).toEqual({ role: v, unrecognised: null });
    });

    it('is case and whitespace insensitive', () => {
      expect(parseProcessRole('  WORKER ').role).toBe('worker');
    });

    // The failure this guards: a service deployed before anyone sets ROLE, or
    // a variable somebody removes, must behave exactly as today.
    it('defaults to all when unset', () => {
      expect(parseProcessRole(undefined).role).toBe('all');
      expect(parseProcessRole('').role).toBe('all');
      expect(DEFAULT_PROCESS_ROLE).toBe('all');
    });

    // A typo in a dashboard field must not take the platform down, but it must
    // not pass silently either.
    it('falls back to all and reports an unrecognised value', () => {
      expect(parseProcessRole('wrker')).toEqual({
        role: 'all',
        unrecognised: 'wrker',
      });
    });

    it('reads the ROLE variable', () => {
      expect(PROCESS_ROLE_ENV).toBe('ROLE');
      expect(processRole({ ROLE: 'worker' } as NodeJS.ProcessEnv)).toBe(
        'worker',
      );
      expect(processRole({} as NodeJS.ProcessEnv)).toBe('all');
    });
  });

  describe('what each role does', () => {
    it('all does everything — today\u2019s behaviour', () => {
      expect(servesHttp('all')).toBe(true);
      expect(runsQueues('all')).toBe(true);
      expect(runsCrons('all')).toBe(true);
    });

    // The point of the split: web must not process queues, or an API request
    // can still land behind a publish on this event loop.
    it('web serves HTTP and runs no background work', () => {
      expect(servesHttp('web')).toBe(true);
      expect(runsQueues('web')).toBe(false);
      expect(runsCrons('web')).toBe(false);
    });

    it('worker runs background work and serves no ordinary routes', () => {
      expect(servesHttp('worker')).toBe(false);
      expect(runsQueues('worker')).toBe(true);
      expect(runsCrons('worker')).toBe(true);
    });

    // Crons exist to enqueue work, so a process that cannot drain the queue
    // must not fill it. Pinning the tie prevents a future third switch.
    it('ties crons to queues for every role', () => {
      (['all', 'web', 'worker'] as const).forEach((r) =>
        expect(runsCrons(r)).toBe(runsQueues(r)),
      );
    });

    it('always has exactly one role serving each job', () => {
      // Guards against someone making 'web' the no-HTTP role by accident.
      expect(servesHttp('web')).toBe(true);
      expect(runsQueues('worker')).toBe(true);
    });
  });
});
