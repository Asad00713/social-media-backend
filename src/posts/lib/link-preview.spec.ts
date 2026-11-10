import { absoluteHttpsImage, readLinkPreview } from './link-preview';
import {
  extractPageMeta,
  fetchPublicHtml,
} from '../../media-library/lib/link-meta';

// The reader must go through the SSRF-safe helpers and nothing else: these
// mocks stand in for them, and a bare fetch would bypass both.
jest.mock('../../media-library/lib/link-meta', () => ({
  fetchPublicHtml: jest.fn(),
  extractPageMeta: jest.fn(),
}));
const mockFetchHtml = fetchPublicHtml as jest.MockedFunction<
  typeof fetchPublicHtml
>;
const mockExtract = extractPageMeta as jest.MockedFunction<
  typeof extractPageMeta
>;

describe('readLinkPreview', () => {
  beforeEach(() => {
    mockFetchHtml.mockReset();
    mockExtract.mockReset();
  });

  it('reads the page through fetchPublicHtml and extractPageMeta', async () => {
    mockFetchHtml.mockResolvedValue({
      html: '<head></head>',
      finalUrl: 'https://shop.example/menu/',
    });
    mockExtract.mockReturnValue({
      title: '  Autumn   menu ',
      description: 'Seasonal drinks',
      imageUrl: '/img/hero.jpg',
      siteName: 'Lumiere',
      faviconUrl: 'https://shop.example/favicon.ico',
    });

    const preview = await readLinkPreview('https://shop.example/menu');

    expect(mockFetchHtml).toHaveBeenCalledWith(
      'https://shop.example/menu',
      expect.objectContaining({ 'User-Agent': expect.any(String) }),
    );
    // Relative og:image resolves against the page actually served.
    expect(mockExtract).toHaveBeenCalledWith(
      '<head></head>',
      'https://shop.example/menu/',
    );
    expect(preview).toEqual({
      url: 'https://shop.example/menu',
      title: 'Autumn menu',
      description: 'Seasonal drinks',
      imageUrl: 'https://shop.example/img/hero.jpg',
      siteName: 'Lumiere',
      isReadable: true,
    });
  });

  it('is unreadable, not an error, when the page cannot be fetched', async () => {
    mockFetchHtml.mockResolvedValue(null);
    await expect(readLinkPreview('https://a.example')).resolves.toEqual({
      url: 'https://a.example',
      isReadable: false,
    });
  });

  it('is unreadable when the guard refuses the host (private address)', async () => {
    mockFetchHtml.mockRejectedValue(new Error('private address'));
    await expect(readLinkPreview('https://10.0.0.1')).resolves.toEqual({
      url: 'https://10.0.0.1',
      isReadable: false,
    });
    expect(mockExtract).not.toHaveBeenCalled();
  });
});

describe('absoluteHttpsImage', () => {
  const page = 'https://a.example/post/1';
  it('keeps an absolute https image', () => {
    expect(absoluteHttpsImage('https://cdn.example/x.jpg', page)).toBe(
      'https://cdn.example/x.jpg',
    );
  });
  it('resolves protocol-relative and relative values', () => {
    expect(absoluteHttpsImage('//cdn.example/x.jpg', page)).toBe(
      'https://cdn.example/x.jpg',
    );
    expect(absoluteHttpsImage('x.jpg', page)).toBe(
      'https://a.example/post/x.jpg',
    );
  });
  it('drops an http image and an empty value', () => {
    expect(
      absoluteHttpsImage('http://cdn.example/x.jpg', page),
    ).toBeUndefined();
    expect(absoluteHttpsImage('  ', page)).toBeUndefined();
    expect(absoluteHttpsImage(undefined, page)).toBeUndefined();
  });
});
