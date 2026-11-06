import { ConfigService } from '@nestjs/config';
import { MastodonService } from './mastodon.service';

// These tests stub the network with `global.fetch`. The media download goes
// through the SSRF-guarded fetchPublicMedia (undici + a pinned-DNS agent), so
// route it back to the stub; the guard itself is covered in public-fetch.spec.
jest.mock('../../common/net/public-fetch', () => ({
  ...jest.requireActual<typeof import('../../common/net/public-fetch')>(
    '../../common/net/public-fetch',
  ),
  fetchPublicMedia: (url: string) => global.fetch(url),
}));

/**
 * What `uploadMedia` puts on the wire. The multipart body is assembled by hand,
 * so a field added to it is only right if it is a part of the form — not a URL
 * parameter, not a header — and a wrong placement fails quietly: Mastodon
 * ignores a field it does not read and crops the picture around its centre.
 */
describe('MastodonService.uploadMedia', () => {
  const INSTANCE = 'mastodon.example';
  const MEDIA_URL = 'https://cdn.example/photos/sunset.jpg';

  let service: MastodonService;
  let fetchMock: jest.SpyInstance;

  /** The POST to the instance, which is the second call after the download. */
  const upload = () => {
    const call = fetchMock.mock.calls.find(([url]) => url !== MEDIA_URL) as [
      string,
      { method: string; headers: Record<string, string>; body: Buffer },
    ];
    return { url: call[0], init: call[1], body: call[1].body.toString('utf8') };
  };

  beforeEach(() => {
    service = new MastodonService({
      get: jest.fn(),
    } as unknown as ConfigService);
    fetchMock = jest
      .spyOn(global, 'fetch')
      .mockImplementation((input: string | URL | Request) => {
        const requested =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        if (requested === MEDIA_URL) {
          return Promise.resolve({
            ok: true,
            arrayBuffer: () =>
              Promise.resolve(new TextEncoder().encode('JPEGBYTES').buffer),
            headers: { get: () => 'image/jpeg' },
          } as unknown as Response);
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              id: 'media-1',
              type: 'image',
              url: 'https://m/a.jpg',
              preview_url: 'https://m/p.jpg',
            }),
        } as unknown as Response);
      });
  });
  afterEach(() => jest.restoreAllMocks());

  it('sends the focal point as a `focus` part of the multipart form', async () => {
    await service.uploadMedia(
      INSTANCE,
      'tok',
      MEDIA_URL,
      'a sunset',
      undefined,
      '-0.6,-0.6',
    );

    const { url, body } = upload();
    expect(url).toBe('https://mastodon.example/api/v2/media');
    // A form part, exactly: header, blank line, value, CRLF.
    expect(body).toContain(
      'Content-Disposition: form-data; name="focus"\r\n\r\n-0.6,-0.6\r\n',
    );
    // Not a query parameter on the URL.
    expect(url).not.toContain('focus');
  });

  it('keeps the description and the file beside it', async () => {
    await service.uploadMedia(
      INSTANCE,
      'tok',
      MEDIA_URL,
      'a sunset',
      undefined,
      '0,1',
    );

    const { body } = upload();
    expect(body).toContain('name="file"; filename="sunset.jpg"');
    expect(body).toContain('JPEGBYTES');
    expect(body).toContain('name="description"\r\n\r\na sunset\r\n');
    expect(body).toContain('name="focus"\r\n\r\n0,1\r\n');
  });

  it('puts every part inside the form, closed by the final boundary', async () => {
    await service.uploadMedia(
      INSTANCE,
      'tok',
      MEDIA_URL,
      'alt',
      undefined,
      '0.5,-0.5',
    );

    const { init, body } = upload();
    const boundary =
      /boundary=(.+)$/.exec(init.headers['Content-Type'])?.[1] ?? '';
    expect(boundary).not.toBe('');
    // file + description + focus = three parts, each opened by the boundary.
    expect(body.split(`--${boundary}\r\n`)).toHaveLength(4);
    expect(body.endsWith(`--${boundary}--\r\n`)).toBe(true);
    // The focus part sits before the closing boundary, not after it.
    expect(body.indexOf('name="focus"')).toBeLessThan(
      body.lastIndexOf(`--${boundary}--`),
    );
  });

  it('sends no focus part when none was given', async () => {
    // An absent focus leaves Mastodon to centre. An empty part would be one
    // more field an older instance could reject.
    await service.uploadMedia(INSTANCE, 'tok', MEDIA_URL, 'a sunset');

    expect(upload().body).not.toContain('name="focus"');
  });

  it('sends a focus when there is no description', async () => {
    await service.uploadMedia(
      INSTANCE,
      'tok',
      MEDIA_URL,
      undefined,
      undefined,
      '1,-1',
    );

    const { body } = upload();
    expect(body).not.toContain('name="description"');
    expect(body).toContain('name="focus"\r\n\r\n1,-1\r\n');
  });

  it('still honours the content-type override beside the focus', async () => {
    await service.uploadMedia(
      INSTANCE,
      'tok',
      MEDIA_URL,
      undefined,
      'image/png',
      '0,0',
    );

    expect(upload().body).toContain('Content-Type: image/png');
  });
});
