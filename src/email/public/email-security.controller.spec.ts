import type { Response } from 'express';
import { EmailSecurityController } from './email-security.controller';
import type { SecurityActionsService } from './security-actions.service';

/** Just enough of express's Response to read what the handler sent. */
function fakeRes() {
  const headers: Record<string, string> = {};
  const sent: { status?: number; type?: string; body?: string } = {};
  const res = {} as Record<string, unknown>;
  Object.assign(res, {
    setHeader: (k: string, v: string) => {
      headers[k] = v;
    },
    status: (code: number) => {
      sent.status = code;
      return res;
    },
    type: (t: string) => {
      sent.type = t;
      return res;
    },
    send: (body: string) => {
      sent.body = body;
      return res;
    },
  });
  return { res: res as unknown as Response, headers, sent };
}

function setup(
  ask: Awaited<ReturnType<SecurityActionsService['describe']>>,
  done: Awaited<ReturnType<SecurityActionsService['perform']>>,
) {
  const actions = {
    describe: jest.fn().mockResolvedValue(ask),
    perform: jest.fn().mockResolvedValue(done),
  };
  const controller = new EmailSecurityController(
    actions as unknown as SecurityActionsService,
  );
  return { controller, actions };
}

const ASK = {
  title: 'Secure your account?',
  body: "We'll sign you out everywhere and send a password reset link to r•••@x.pk.",
  button: 'Secure my account',
};

describe('EmailSecurityController', () => {
  it('GET only asks: a form that posts back to the same link, private and never cached', async () => {
    const { controller, actions } = setup(ASK, null);
    const { res, headers, sent } = fakeRes();

    await controller.confirm('a.b.c', res);

    expect(actions.perform).not.toHaveBeenCalled();
    expect(sent.status).toBe(200);
    expect(sent.type).toBe('text/html; charset=utf-8');
    expect(sent.body).toContain(
      '<form method="post" action="/email/security/a.b.c">',
    );
    expect(sent.body).toContain('Secure my account');
    expect(sent.body).toContain('r•••@x.pk');
    expect(sent.body).not.toContain('<script');
    expect(headers).toMatchObject({
      'Cache-Control': 'private, no-store',
      'X-Robots-Tag': 'noindex',
      'Referrer-Policy': 'no-referrer',
    });
    expect(headers['Content-Security-Policy']).toContain("default-src 'none'");
  });

  it('a bad token is the plain "This link doesn\'t work" page, 404, on both steps', async () => {
    const { controller, actions } = setup(null, null);

    const get = fakeRes();
    await controller.confirm('bad', get.res);
    const post = fakeRes();
    await controller.act('bad', post.res);

    for (const { sent, headers } of [get, post]) {
      expect(sent.status).toBe(404);
      expect(sent.body).toContain('This link doesn&#39;t work');
      expect(sent.body).toContain('Security links work for 7 days');
      expect(headers['Referrer-Policy']).toBe('no-referrer');
    }
    expect(actions.describe).toHaveBeenCalledTimes(1);
  });

  it('POST acts and shows the outcome', async () => {
    const { controller, actions } = setup(ASK, {
      title: 'Your account is secured',
      body: 'We signed you out everywhere and sent a reset link to r•••@x.pk.',
    });
    const { res, sent, headers } = fakeRes();

    await controller.act('a.b.c', res);

    expect(actions.perform).toHaveBeenCalledWith('a.b.c');
    expect(actions.describe).not.toHaveBeenCalled();
    expect(sent.status).toBe(200);
    expect(sent.body).toContain('Your account is secured');
    expect(sent.body).not.toContain('<form');
    expect(headers['Cache-Control']).toBe('private, no-store');
  });
});
