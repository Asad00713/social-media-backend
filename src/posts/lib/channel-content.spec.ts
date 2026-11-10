import { channelContent } from './channel-content';

const shared = {
  content: 'shared',
  mediaItems: [{ url: 'https://cdn/a.jpg', type: 'image' }] as any,
};

describe('channelContent', () => {
  it('takes the composer override over the shared post', () => {
    const out = channelContent(
      {
        ...shared,
        platformContent: {
          x: {
            overrides: {
              text: 'own',
              mediaItems: [{ url: 'https://cdn/x.jpg', type: 'image' }],
            },
          },
        },
      },
      'x',
    );
    expect(out.text).toBe('own');
    expect(out.mediaItems.map((m) => m.url)).toEqual(['https://cdn/x.jpg']);
  });

  it('inherits each field the override leaves out', () => {
    const out = channelContent(
      { ...shared, platformContent: { x: { overrides: { text: 'own' } } } },
      'x',
    );
    expect(out.text).toBe('own');
    expect(out.mediaItems.map((m) => m.url)).toEqual(['https://cdn/a.jpg']);
  });

  it('keeps an override cleared to "" empty, as Publish now does', () => {
    const out = channelContent(
      { ...shared, platformContent: { x: { overrides: { text: '' } } } },
      'x',
    );
    expect(out.text).toBe('');
  });

  it('reads the legacy flat keys, and falls back to the post', () => {
    expect(
      channelContent({ ...shared, platformContent: { x: { text: 'legacy' } } }, 'x')
        .text,
    ).toBe('legacy');
    expect(channelContent({ ...shared, platformContent: {} }, 'x').text).toBe(
      'shared',
    );
    expect(channelContent({ platformContent: null }, 'x')).toEqual({
      text: '',
      mediaItems: [],
    });
  });
});
