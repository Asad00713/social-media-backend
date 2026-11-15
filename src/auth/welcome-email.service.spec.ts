import { Logger } from '@nestjs/common';
import { AppLinks } from '../email/links/app-links';
import type { EnqueueEmail } from '../email/queue/email-job';
import type { WelcomeProps } from '../email/templates/lifecycle/welcome';
import { WelcomeEmailService } from './welcome-email.service';

const USER = '3f0f5a52-6d8b-4b5e-9a37-0a1c2d3e4f50';

function make(
  over: { claim?: boolean | Error; enqueue?: jest.Mock; once?: boolean } = {},
) {
  const enqueue = over.enqueue ?? jest.fn().mockResolvedValue(undefined);
  const claim = jest.fn(() =>
    over.claim instanceof Error
      ? Promise.reject(over.claim)
      : Promise.resolve(over.claim ?? true),
  );
  const release = jest.fn(() => Promise.resolve());
  const links = new AppLinks({
    get: (key: string) =>
      key === 'FRONTEND_URL' ? 'https://app.test' : undefined,
  } as never);
  const service = new WelcomeEmailService(
    { enqueue } as never,
    { claim, release } as never,
    links,
  );
  return { service, enqueue, claim, release };
}

function job(enqueue: jest.Mock): EnqueueEmail<WelcomeProps> {
  return (
    enqueue.mock.calls as unknown[][]
  )[0][0] as EnqueueEmail<WelcomeProps>;
}

describe('WelcomeEmailService', () => {
  afterEach(() => jest.restoreAllMocks());

  it('enqueues the welcome email once, keyed on the user id', async () => {
    const { service, enqueue, claim } = make();
    await service.send({ id: USER, email: 'a@b.co', name: 'Rehman Khan' });

    expect(claim).toHaveBeenCalledWith(`welcome.${USER}`, 30 * 86400);
    expect(enqueue).toHaveBeenCalledTimes(1);
    const sent = job(enqueue);
    expect(sent.template.id).toBe('welcome');
    expect(sent.idempotencyKey).toBe(`welcome.${USER}`);
    expect(sent.to).toEqual({ email: 'a@b.co', userId: USER });
    expect(sent.workspaceId).toBeNull();
    expect(sent.props).toEqual({
      firstName: 'Rehman',
      openUrl: 'https://app.test/',
    });
  });

  it('sends nothing when the welcome was already claimed', async () => {
    const { service, enqueue } = make({ claim: false });
    await service.send({ id: USER, email: 'a@b.co', name: 'Rehman' });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it.each([null, '', '   '])(
    'greets "there" for a name of %p',
    async (name) => {
      const { service, enqueue } = make();
      await service.send({ id: USER, email: 'a@b.co', name });
      expect(job(enqueue).props.firstName).toBe('there');
    },
  );

  it('never rejects and logs neither the address nor the name when the enqueue fails', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const { service } = make({
      enqueue: jest.fn().mockRejectedValue(new Error('redis down')),
    });
    await expect(
      service.send({ id: USER, email: 'secret@b.co', name: 'Rehman' }),
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0][0]);
    expect(line).toContain(USER);
    expect(line).toContain('redis down');
    expect(line).not.toContain('secret@b.co');
    expect(line).not.toContain('Rehman');
  });

  it('gives the claim back when the enqueue fails, so the next verify can send', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const { service, release } = make({
      enqueue: jest.fn().mockRejectedValue(new Error('redis down')),
    });
    await service.send({ id: USER, email: 'a@b.co', name: 'Rehman' });
    expect(release).toHaveBeenCalledWith(`welcome.${USER}`);
  });

  it('keeps the claim after a send, and touches none it did not take', async () => {
    const sent = make();
    await sent.service.send({ id: USER, email: 'a@b.co', name: 'Rehman' });
    expect(sent.release).not.toHaveBeenCalled();

    const taken = make({ claim: false });
    await taken.service.send({ id: USER, email: 'a@b.co', name: 'Rehman' });
    expect(taken.release).not.toHaveBeenCalled();
  });

  it('never rejects when the claim itself throws', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const { service, enqueue, release } = make({ claim: new Error('boom') });
    await expect(
      service.send({ id: USER, email: 'a@b.co', name: 'Rehman' }),
    ).resolves.toBeUndefined();
    expect(enqueue).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });
});
