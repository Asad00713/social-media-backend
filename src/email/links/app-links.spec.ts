import type { ConfigService } from '@nestjs/config';
import { AppLinks } from './app-links';

function cfg(values: Record<string, string>): ConfigService {
  return {
    get: (key: string, def?: string) => values[key] ?? def,
  } as unknown as ConfigService;
}

describe('AppLinks', () => {
  it('FRONTEND_URL defaults to http://localhost:3001', () =>
    expect(new AppLinks(cfg({})).frontend('/x')).toBe(
      'http://localhost:3001/x',
    ));

  it('uses the defaults for every other base', () => {
    const links = new AppLinks(cfg({}));
    expect(links.api('/email/x')).toBe('http://localhost:3000/email/x');
    expect(links.assetBase()).toBe('http://localhost:3001/email');
    expect(links.help()).toBe('https://schedura.ai/help');
    expect(links.billingHelp()).toBe('https://schedura.ai/help/billing');
    expect(links.privacy()).toBe('https://schedura.ai/privacy');
    expect(links.status()).toBe('https://schedura.ai/status');
    expect(links.supportEmail()).toBe('support@schedura.ai');
  });

  it('strips trailing slashes from every base', () => {
    const links = new AppLinks(
      cfg({
        FRONTEND_URL: 'https://app.schedura.ai/',
        API_PUBLIC_URL: 'https://api.schedura.ai//',
        MARKETING_URL: 'https://schedura.ai/',
        EMAIL_ASSET_BASE_URL: 'https://cdn.schedura.ai/email/',
      }),
    );
    expect(links.frontend('/x')).toBe('https://app.schedura.ai/x');
    expect(links.api('/y')).toBe('https://api.schedura.ai/y');
    expect(links.help()).toBe('https://schedura.ai/help');
    expect(links.assetBase()).toBe('https://cdn.schedura.ai/email');
  });

  it('derives the asset base from FRONTEND_URL when EMAIL_ASSET_BASE_URL is unset', () => {
    const links = new AppLinks(
      cfg({ FRONTEND_URL: 'https://app.schedura.ai' }),
    );
    expect(links.assetBase()).toBe('https://app.schedura.ai/email');
  });

  it('prefers API_PUBLIC_URL, then APP_URL, for the API base', () => {
    expect(
      new AppLinks(cfg({ APP_URL: 'https://app-url.test' })).api('/a'),
    ).toBe('https://app-url.test/a');
    expect(
      new AppLinks(
        cfg({
          API_PUBLIC_URL: 'https://api.schedura.ai',
          APP_URL: 'https://app-url.test',
        }),
      ).api('/a'),
    ).toBe('https://api.schedura.ai/a');
  });

  it('uses SUPPORT_EMAIL when set', () => {
    expect(
      new AppLinks(cfg({ SUPPORT_EMAIL: 'help@acme.com' })).supportEmail(),
    ).toBe('help@acme.com');
  });

  it('adds the leading slash a path is missing', () => {
    expect(new AppLinks(cfg({})).frontend('login')).toBe(
      'http://localhost:3001/login',
    );
  });

  it('builds the frontend routes the emails link to', () => {
    const links = new AppLinks(cfg({}));
    const fe = 'http://localhost:3001';
    expect(links.workspace('ws1', '/home')).toBe(`${fe}/w/ws1/home`);
    expect(links.planner('ws1')).toBe(`${fe}/w/ws1/planner`);
    expect(links.planner('ws1', 'p1')).toBe(`${fe}/w/ws1/planner?post=p1`);
    expect(links.channels('ws1')).toBe(`${fe}/w/ws1/channels`);
    expect(links.billing('ws1')).toBe(`${fe}/w/ws1/settings/billing`);
    expect(links.members('ws1')).toBe(`${fe}/w/ws1/settings/team`);
    expect(links.notifications('ws1')).toBe(
      `${fe}/w/ws1/settings/notifications`,
    );
    expect(links.inbox('ws1', 'c1')).toBe(`${fe}/w/ws1/inbox?c=c1`);
    expect(links.invite('tok')).toBe(`${fe}/invite/accept?token=tok`);
    expect(links.resetPassword('tok')).toBe(`${fe}/reset-password?token=tok`);
  });

  it('encodes ids and tokens', () => {
    const links = new AppLinks(cfg({}));
    expect(links.inbox('ws/1', '12:a&b')).toBe(
      'http://localhost:3001/w/ws%2F1/inbox?c=12%3Aa%26b',
    );
    expect(links.invite('a+b=')).toBe(
      'http://localhost:3001/invite/accept?token=a%2Bb%3D',
    );
  });
});
