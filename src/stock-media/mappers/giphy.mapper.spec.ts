import { mapGiphyGif } from './giphy.mapper';
import type { GiphyGif } from '../providers/giphy.service';

function buildGif(overrides: Partial<GiphyGif> = {}): GiphyGif {
  return {
    id: 'abc123',
    url: 'https://giphy.com/gifs/abc123',
    title: 'Funny Cat',
    username: 'catlover',
    images: {
      original: {
        url: 'https://media.giphy.com/media/abc123/giphy.gif',
        width: '480',
        height: '270',
      },
      fixed_width: {
        url: 'https://media.giphy.com/media/abc123/200w.gif',
        width: '200',
        height: '113',
      },
      downsized: {
        url: 'https://media.giphy.com/media/abc123/giphy-downsized.gif',
        width: '400',
        height: '225',
      },
    },
    ...overrides,
  };
}

describe('mapGiphyGif', () => {
  it('maps a gif to a StockMediaItem of type image with the original .gif fullUrl', () => {
    const gif = buildGif();

    const item = mapGiphyGif(gif);

    expect(item.provider).toBe('giphy');
    expect(item.providerId).toBe('abc123');
    expect(item.type).toBe('image');
    expect(item.fullUrl).toBe(
      'https://media.giphy.com/media/abc123/giphy.gif',
    );
  });

  it('uses the fixed_width image as the previewUrl', () => {
    const gif = buildGif();

    const item = mapGiphyGif(gif);

    expect(item.previewUrl).toBe(
      'https://media.giphy.com/media/abc123/200w.gif',
    );
  });

  it('coerces width and height to numbers', () => {
    const gif = buildGif();

    const item = mapGiphyGif(gif);

    expect(item.width).toBe(480);
    expect(item.height).toBe(270);
    expect(typeof item.width).toBe('number');
    expect(typeof item.height).toBe('number');
  });

  it('falls back to "GIPHY" for authorName when user and username are absent', () => {
    const gif = buildGif({ username: '' as unknown as string });
    delete gif.user;

    const item = mapGiphyGif(gif);

    expect(item.authorName).toBe('GIPHY');
    expect(item.authorUrl).toBe(gif.url);
  });

  it('prefers user.display_name and user.profile_url when present', () => {
    const gif = buildGif({
      user: {
        display_name: 'Cat Lover',
        profile_url: 'https://giphy.com/catlover',
      },
    });

    const item = mapGiphyGif(gif);

    expect(item.authorName).toBe('Cat Lover');
    expect(item.authorUrl).toBe('https://giphy.com/catlover');
  });
});
