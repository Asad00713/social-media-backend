import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Fail-closed net over the wiring, not the logic.
 *
 * The logic is pinned by the sibling specs. What those cannot see is whether
 * the gates are still REACHED: an import removed from AppModule, or the module
 * moved above the queue registrations, leaves every test green while the split
 * silently stops being enforced in production.
 */
const src = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(src, p), 'utf8');
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('process role wiring', () => {
  const appModule = stripComments(read('app.module.ts'));
  const main = stripComments(read('main.ts'));

  it('registers ProcessRoleModule in AppModule', () => {
    expect(appModule).toContain('ProcessRoleModule');
  });

  // Both gates read registries the modules above populate. Registered too
  // early, they find nothing and enforce nothing -- with no test failure.
  it('registers it after ScheduleModule and the queue registrations', () => {
    const role = appModule.indexOf('    ProcessRoleModule,');
    const schedule = appModule.indexOf('ScheduleModule.forRoot()');
    const queues = appModule.lastIndexOf('BullBoardModule.forFeature');
    expect(role).toBeGreaterThan(-1);
    expect(role).toBeGreaterThan(schedule);
    expect(role).toBeGreaterThan(queues);
  });

  it('gates ordinary HTTP routes on the role in main.ts', () => {
    expect(main).toContain('servesHttp');
    expect(main).toMatch(/if \(!servesHttp\(role\)\)/);
  });

  // A worker that never binds a port is a failed deploy, restarted forever.
  it('still listens, and still answers /health, on a worker', () => {
    expect(main).toContain("app.listen(port, '0.0.0.0')");
    expect(main).toMatch(/req\.path === '\/health'/);
  });

  it('keeps the cron single-run lock, which this does not replace', () => {
    // A rolling deploy runs two workers briefly; both would fire every cron.
    expect(appModule).toContain('SchedulingModule');
  });
});
