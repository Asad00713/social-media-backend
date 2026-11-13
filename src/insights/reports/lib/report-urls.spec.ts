import type { ConfigService } from '@nestjs/config';
import { reportsFrontendUrl, reportShareUrl } from './report-urls';

const config = (url?: string) =>
  ({ get: () => url }) as unknown as ConfigService;

describe('reportsFrontendUrl', () => {
  it('drops trailing slashes', () => {
    expect(reportsFrontendUrl(config('https://app.acme.com//'))).toBe(
      'https://app.acme.com',
    );
  });

  it('falls back to the local app', () => {
    expect(reportsFrontendUrl(config())).toBe('http://localhost:3001');
  });
});

describe('reportShareUrl', () => {
  it('puts the token under /r', () => {
    expect(reportShareUrl('https://app.acme.com', 'abc')).toBe(
      'https://app.acme.com/r/abc',
    );
  });
});
