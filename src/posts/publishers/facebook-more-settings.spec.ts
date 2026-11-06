import { FacebookPublisher } from './facebook.publisher';
import { FacebookService } from '../../channels/services/facebook.service';
import { PublishOptions } from './base.publisher';
import {
  facebookCollaborator,
  facebookPlace,
  facebookPostOptions,
} from './facebook-post-settings';
import { listFacebookWorkspacePages } from '../../channels/facebook-workspace-pages';

/**
 * Facebook's "More settings" (backdate, minimum age), Location (`place`) and
 * a Reel's Collaborator. The service tests pin the REQUEST - a misplaced key
 * is ignored or rejects the post, and neither shows until publish - and the
 * publisher tests prove each draft key reaches the service.
 */

const NOW = Date.parse('2026-11-06T12:00:00Z');

describe('facebookPostOptions', () => {
  it('sends a past backdate as Unix seconds', () => {
    expect(
      facebookPostOptions({ backdatedTime: '2024-03-01T09:30:00Z' }, NOW),
    ).toEqual({ backdatedTime: Date.parse('2024-03-01T09:30:00Z') / 1000 });
  });

  it('does not send a backdate in the future, or one that does not parse', () => {
    expect(
      facebookPostOptions({ backdatedTime: '2027-01-01T00:00:00Z' }, NOW),
    ).toEqual({});
    expect(facebookPostOptions({ backdatedTime: 'soon' }, NOW)).toEqual({});
    expect(facebookPostOptions({ backdatedTime: 1700000000 }, NOW)).toEqual({});
  });

  it('sends only the minimum ages Graph lists', () => {
    for (const age of [13, 15, 18, 21, 25]) {
      expect(facebookPostOptions({ minAge: age }, NOW)).toEqual({
        targeting: { age_min: age },
      });
    }
    for (const age of [0, 16, 30, '18']) {
      expect(facebookPostOptions({ minAge: age }, NOW)).toEqual({});
    }
  });

  it('reads place and collaborator as Page ids only', () => {
    expect(facebookPlace({ place: ' 1234567 ' })).toBe('1234567');
    expect(facebookPlace({ place: 'Lahore' })).toBeUndefined();
    expect(facebookPlace({ place: '' })).toBeUndefined();
    expect(facebookPlace(undefined)).toBeUndefined();
    expect(facebookCollaborator({ collaboratorPageId: '987' })).toBe('987');
    expect(facebookCollaborator({ collaboratorPageId: 987 })).toBeUndefined();
    expect(facebookPostOptions({ place: '42' }, NOW)).toEqual({ place: '42' });
  });

  it('is empty for a draft with none of these', () => {
    expect(facebookPostOptions({}, NOW)).toEqual({});
    expect(facebookPostOptions(undefined, NOW)).toEqual({});
  });
});

describe('FacebookService - the More settings on the request', () => {
  let service: FacebookService;
  let fetchMock: jest.Mock;

  const bodyOf = (call = 0) =>
    JSON.parse(fetchMock.mock.calls[call][1].body as string);

  beforeEach(() => {
    service = new FacebookService();
    fetchMock = jest.fn().mockImplementation(async (input: unknown) => {
      const url = String(input);
      const body = url.includes('upload_phase=start')
        ? { video_id: 'vid-1', upload_url: 'https://rupload.example/vid-1' }
        : { id: 'post-1', success: true };
      return {
        ok: true,
        status: 200,
        json: async () => body,
        text: async () => JSON.stringify(body),
      };
    });
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  const ALL = {
    backdatedTime: 1709285400,
    targeting: { age_min: 18 },
    place: '1234567',
  };

  it('puts backdate, targeting and place on the feed post body', async () => {
    await service.postToPage('page-1', 'tok', 'hi', undefined, undefined, ALL);
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/page-1\/feed$/);
    const body = bodyOf();
    expect(body.backdated_time).toBe('1709285400');
    expect(typeof body.targeting).toBe('string');
    expect(JSON.parse(body.targeting)).toEqual({ age_min: 18 });
    expect(body.place).toBe('1234567');
    expect('feed_targeting' in body).toBe(false);
  });

  it('puts the same keys on the photo post body', async () => {
    await service.postPhotoToPage(
      'page-1',
      'tok',
      'https://cdn.example/a.jpg',
      'cap',
      ALL,
    );
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/page-1\/photos$/);
    const body = bodyOf();
    expect(body.backdated_time).toBe('1709285400');
    expect(JSON.parse(body.targeting)).toEqual({ age_min: 18 });
    expect(body.place).toBe('1234567');
  });

  it('makes exactly the old requests when nothing is set', async () => {
    await service.postToPage('p', 'tok', 'hello', undefined, undefined, {});
    expect(bodyOf(0)).toEqual({ access_token: 'tok', message: 'hello' });
    await service.postPhotoToPage('p', 'tok', 'https://x/a.jpg', 'c', {});
    expect(bodyOf(1)).toEqual({
      access_token: 'tok',
      url: 'https://x/a.jpg',
      caption: 'c',
    });
  });

  it('sends a Reel place on the FINISH call only', async () => {
    await service.postReelToPage('page-1', 'tok', 'https://x/v.mp4', 'd', {
      place: '1234567',
    });
    const start = new URL(String(fetchMock.mock.calls[0][0]));
    const finish = new URL(String(fetchMock.mock.calls[2][0]));
    expect(start.searchParams.has('place')).toBe(false);
    expect(finish.searchParams.get('upload_phase')).toBe('finish');
    expect(finish.searchParams.get('place')).toBe('1234567');
  });

  it('sends no Reel place when none is chosen', async () => {
    await service.postReelToPage('page-1', 'tok', 'https://x/v.mp4', 'd', {});
    const finish = new URL(String(fetchMock.mock.calls[2][0]));
    expect(finish.searchParams.has('place')).toBe(false);
  });

  it('invites a collaborator on the video’s /collaborators edge with target_id', async () => {
    await service.inviteReelCollaborator('vid-1', 'tok', '987');
    const [input, init] = fetchMock.mock.calls[0];
    const url = new URL(String(input));
    expect(init.method).toBe('POST');
    expect(url.pathname).toMatch(/\/vid-1\/collaborators$/);
    expect(url.searchParams.get('target_id')).toBe('987');
    expect(url.searchParams.get('access_token')).toBe('tok');
  });

  it('throws when Facebook refuses the invite', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ error: { message: 'limit reached' } }),
    });
    await expect(
      service.inviteReelCollaborator('vid-1', 'tok', '987'),
    ).rejects.toThrow('limit reached');
  });

  it('reads a Page’s location with that Page’s token', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        id: '42',
        name: 'Lumière Gulberg',
        location: {
          city: 'Lahore',
          country: 'Pakistan',
          latitude: 31.5,
          longitude: 74.3,
        },
      }),
    });
    const page = await service.getPageLocation('42', 'page-tok');
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.pathname).toMatch(/\/42$/);
    expect(url.searchParams.get('fields')).toBe('id,name,location');
    expect(url.searchParams.get('access_token')).toBe('page-tok');
    expect(page).toEqual({
      id: '42',
      name: 'Lumière Gulberg',
      location: 'Lahore, Pakistan',
    });
  });

  it('reports no location for a Page without one', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ id: '43', name: 'Online shop' }),
    });
    expect((await service.getPageLocation('43', 't')).location).toBeNull();
  });
});

describe('FacebookPublisher - More settings, Location and Collaborator', () => {
  let publisher: FacebookPublisher;
  let service: Record<string, jest.Mock>;

  const options = (
    metadata: Record<string, unknown>,
    over: Partial<PublishOptions> = {},
  ): PublishOptions =>
    ({
      content: 'a caption',
      mediaItems: [],
      accessToken: 'page-token',
      metadata,
      channelMetadata: {},
      platformAccountId: 'page-1',
      channelId: 1,
      ...over,
    }) as PublishOptions;

  const video = [{ type: 'video', url: 'https://cdn.example/v.mp4' } as any];
  const photo = [{ type: 'image', url: 'https://cdn.example/a.jpg' } as any];

  beforeEach(() => {
    service = {
      postReelToPage: jest.fn().mockResolvedValue({ postId: 'reel-1' }),
      postToPage: jest.fn().mockResolvedValue({ postId: 'post-1' }),
      postPhotoToPage: jest.fn().mockResolvedValue({ postId: 'photo-1' }),
      postPhotoStoryToPage: jest.fn().mockResolvedValue({ postId: 'story-1' }),
      inviteReelCollaborator: jest.fn().mockResolvedValue(undefined),
      postComment: jest.fn(),
    };
    publisher = new FacebookPublisher(service as unknown as FacebookService);
  });

  const SETTINGS = {
    backdatedTime: '2024-03-01T09:30:00Z',
    minAge: 18,
    place: '1234567',
  };
  const EXPECTED = {
    backdatedTime: Date.parse('2024-03-01T09:30:00Z') / 1000,
    targeting: { age_min: 18 },
    place: '1234567',
  };

  it('sends them with a text post', async () => {
    await publisher.publish(options({ postType: 'post', ...SETTINGS }));
    expect(service.postToPage.mock.calls[0][5]).toEqual(EXPECTED);
  });

  it('sends them with a photo post', async () => {
    await publisher.publish(
      options({ postType: 'post', ...SETTINGS }, { mediaItems: photo }),
    );
    expect(service.postPhotoToPage.mock.calls[0][4]).toEqual(EXPECTED);
  });

  it('sends a Reel only its place - no backdate, no targeting', async () => {
    await publisher.publish(
      options({ postType: 'reel', ...SETTINGS }, { mediaItems: video }),
    );
    expect(service.postReelToPage.mock.calls[0][4]).toEqual({
      place: '1234567',
    });
  });

  it('invites the collaborator on the published Reel', async () => {
    await publisher.publish(
      options(
        { postType: 'reel', collaboratorPageId: '987' },
        { mediaItems: video },
      ),
    );
    expect(service.inviteReelCollaborator).toHaveBeenCalledWith(
      'reel-1',
      'page-token',
      '987',
    );
  });

  it('never invites the posting Page itself, or anyone on a post', async () => {
    await publisher.publish(
      options(
        { postType: 'reel', collaboratorPageId: '555' },
        { mediaItems: video, platformAccountId: '555' },
      ),
    );
    await publisher.publish(
      options({ postType: 'post', collaboratorPageId: '987' }),
    );
    expect(service.inviteReelCollaborator).not.toHaveBeenCalled();
  });

  it('keeps the Reel published and reports an invite that failed', async () => {
    service.inviteReelCollaborator.mockRejectedValueOnce(
      new Error('limit reached'),
    );
    const result = await publisher.publish(
      options(
        { postType: 'reel', collaboratorPageId: '987' },
        { mediaItems: video },
      ),
    );
    expect(result.platformPostId).toBe('reel-1');
    expect(result.metadata?.collaboratorWarning).toBe('limit reached');
  });

  it('adds no warning when the invite went out', async () => {
    const result = await publisher.publish(
      options(
        { postType: 'reel', collaboratorPageId: '987' },
        { mediaItems: video },
      ),
    );
    expect(result.metadata?.collaboratorWarning).toBeUndefined();
  });
});

describe('listFacebookWorkspacePages', () => {
  it('lists every Page with its location and marks the posting one', async () => {
    const pages = await listFacebookWorkspacePages(2, {
      listFacebookChannels: async () => [
        { id: 1, platformAccountId: '111', accountName: 'Shop' },
        { id: 2, platformAccountId: '222', accountName: 'Café' },
      ],
      getAccessToken: async (id) => `tok-${id}`,
      getPageLocation: async (pageId, token) => ({
        id: pageId,
        name: '',
        location: token === 'tok-2' ? 'Lahore, Pakistan' : null,
      }),
    });
    expect(pages).toEqual([
      {
        channelId: 1,
        pageId: '111',
        name: 'Shop',
        location: null,
        isSelf: false,
      },
      {
        channelId: 2,
        pageId: '222',
        name: 'Café',
        location: 'Lahore, Pakistan',
        isSelf: true,
      },
    ]);
  });

  it('keeps a Page whose location cannot be read, without one', async () => {
    const pages = await listFacebookWorkspacePages(1, {
      listFacebookChannels: async () => [
        { id: 1, platformAccountId: '111', accountName: 'Shop' },
      ],
      getAccessToken: async () => {
        throw new Error('locked');
      },
      getPageLocation: async () => {
        throw new Error('unreachable');
      },
    });
    expect(pages).toEqual([
      {
        channelId: 1,
        pageId: '111',
        name: 'Shop',
        location: null,
        isSelf: true,
      },
    ]);
  });
});
