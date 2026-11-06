import { LinkedInService } from './linkedin.service';

/**
 * Text, image and video moved from the legacy `/v2/ugcPosts` to the
 * versioned Posts API, so "Allow reposts" (`isReshareDisabledByAuthor`)
 * reaches LinkedIn on every format. These pin each REQUEST - the upload
 * calls and the post body - because a misplaced field is either ignored or
 * rejects the post, and neither shows until publish.
 */
describe('LinkedInService - text, image and video on the Posts API', () => {
  let service: LinkedInService;
  let fetchMock: jest.Mock;
  let etags: (string | null)[];

  const VIDEO_BYTES = 10_000;

  const headersOf = (map: Record<string, string | null>) => ({
    get: (name: string) => map[name.toLowerCase()] ?? null,
  });

  beforeEach(() => {
    service = new LinkedInService();
    etags = ['etag-1', 'etag-2'];
    let part = 0;
    fetchMock = jest.fn().mockImplementation(async (input: unknown) => {
      const url = String(input);
      if (url.endsWith('/rest/posts')) {
        return {
          ok: true,
          status: 201,
          headers: headersOf({ 'x-restli-id': 'urn:li:share:1' }),
          json: async () => ({}),
        };
      }
      if (url.includes('/rest/images?action=initializeUpload')) {
        return {
          ok: true,
          json: async () => ({
            value: {
              uploadUrl: 'https://upload.test/img',
              image: 'urn:li:image:I1',
            },
          }),
        };
      }
      if (url.includes('/rest/videos?action=initializeUpload')) {
        return {
          ok: true,
          json: async () => ({
            value: {
              video: 'urn:li:video:V1',
              uploadToken: 'tok-up',
              uploadInstructions: [
                {
                  uploadUrl: 'https://upload.test/p1',
                  firstByte: 0,
                  lastByte: 4999,
                },
                {
                  uploadUrl: 'https://upload.test/p2',
                  firstByte: 5000,
                  lastByte: 9999,
                },
              ],
            },
          }),
        };
      }
      if (url.includes('/rest/videos?action=finalizeUpload')) {
        return { ok: true, json: async () => ({}) };
      }
      if (url.startsWith('https://upload.test/p')) {
        const etag = etags[part++];
        return { ok: true, headers: headersOf({ etag }), text: async () => '' };
      }
      if (url.startsWith('https://upload.test/img')) {
        return { ok: true, text: async () => '' };
      }
      // The file download from our storage.
      return {
        ok: true,
        headers: headersOf({}),
        arrayBuffer: async () =>
          new ArrayBuffer(url.endsWith('.mp4') ? VIDEO_BYTES : 10),
      };
    });
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  const call = (needle: string) => {
    const found = fetchMock.mock.calls.find(([u]) =>
      String(u).includes(needle),
    );
    if (!found) throw new Error(`no call to ${needle}`);
    return found;
  };
  const bodyOf = (needle: string) => JSON.parse(call(needle)[1].body as string);
  const postBody = () => bodyOf('/rest/posts');

  describe('a text post', () => {
    it('is the Posts API envelope alone, with the reshare choice', async () => {
      const result = await service.createRestTextPost(
        'tok',
        'urn:li:person:me',
        'Hello',
        'CONNECTIONS',
        true,
      );
      expect(result.postId).toBe('urn:li:share:1');
      expect(postBody()).toEqual({
        author: 'urn:li:person:me',
        commentary: 'Hello',
        visibility: 'CONNECTIONS',
        distribution: {
          feedDistribution: 'MAIN_FEED',
          targetEntities: [],
          thirdPartyDistributionChannels: [],
        },
        lifecycleState: 'PUBLISHED',
        isReshareDisabledByAuthor: true,
      });
    });

    it('sends the versioned headers', async () => {
      await service.createRestTextPost('tok', 'urn:li:person:me', 'Hi');
      const headers = call('/rest/posts')[1].headers;
      expect(headers['Linkedin-Version']).toMatch(/^\d{6}$/);
      expect(headers['X-Restli-Protocol-Version']).toBe('2.0.0');
      expect(headers.Authorization).toBe('Bearer tok');
    });

    it('never touches the legacy ugcPosts endpoint', async () => {
      await service.createRestTextPost('tok', 'urn:li:person:me', 'Hi');
      expect(
        fetchMock.mock.calls.some(([u]) => String(u).includes('ugcPosts')),
      ).toBe(false);
    });

    it('posts as a page PUBLIC whatever the audience', async () => {
      await service.createRestTextPost(
        'tok',
        'urn:li:organization:42',
        'Hi',
        'CONNECTIONS',
      );
      expect(postBody().author).toBe('urn:li:organization:42');
      expect(postBody().visibility).toBe('PUBLIC');
    });
  });

  describe('an image post', () => {
    it('uploads through the Images API and posts its URN as content.media.id', async () => {
      await service.createRestImagePost(
        'tok',
        'urn:li:person:me',
        'Look',
        'https://cdn.test/a.jpg',
        undefined,
        'PUBLIC',
        true,
      );
      expect(bodyOf('/rest/images?action=initializeUpload')).toEqual({
        initializeUploadRequest: { owner: 'urn:li:person:me' },
      });
      expect(call('https://upload.test/img')[1].method).toBe('PUT');
      expect(postBody().content).toEqual({ media: { id: 'urn:li:image:I1' } });
      expect(postBody().isReshareDisabledByAuthor).toBe(true);
    });

    it('sends a title only when there is one', async () => {
      await service.createRestImagePost(
        'tok',
        'urn:li:person:me',
        'Look',
        'https://cdn.test/a.jpg',
        'Latte art',
      );
      expect(postBody().content.media).toEqual({
        id: 'urn:li:image:I1',
        title: 'Latte art',
      });
    });

    it('refuses a non-web address before registering anything', async () => {
      await expect(
        service.createRestImagePost(
          'tok',
          'urn:li:person:me',
          'x',
          'file:///a.jpg',
        ),
      ).rejects.toThrow(/web/);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('a video post', () => {
    const post = (title?: string) =>
      service.createRestVideoPost(
        'tok',
        'urn:li:person:me',
        'Watch',
        'https://cdn.test/v.mp4',
        title,
        'PUBLIC',
        true,
      );

    it('initializes with the owner and the real file size, no captions or thumbnail', async () => {
      await post();
      expect(bodyOf('/rest/videos?action=initializeUpload')).toEqual({
        initializeUploadRequest: {
          owner: 'urn:li:person:me',
          fileSizeBytes: VIDEO_BYTES,
          uploadCaptions: false,
          uploadThumbnail: false,
        },
      });
    });

    it('PUTs each instructed byte range (inclusive) to its own url, without the token', async () => {
      await post();
      const p1 = call('https://upload.test/p1')[1];
      const p2 = call('https://upload.test/p2')[1];
      expect(p1.method).toBe('PUT');
      expect((p1.body as ArrayBuffer).byteLength).toBe(5000);
      expect((p2.body as ArrayBuffer).byteLength).toBe(5000);
      expect(p1.headers.Authorization).toBeUndefined();
    });

    it('finalizes with the token and the ETags, in instruction order', async () => {
      await post();
      expect(bodyOf('/rest/videos?action=finalizeUpload')).toEqual({
        finalizeUploadRequest: {
          video: 'urn:li:video:V1',
          uploadToken: 'tok-up',
          uploadedPartIds: ['etag-1', 'etag-2'],
        },
      });
    });

    it('strips the quotes a standard ETag carries', async () => {
      etags = ['"q1"', '"q2"'];
      await post();
      expect(
        bodyOf('/rest/videos?action=finalizeUpload').finalizeUploadRequest
          .uploadedPartIds,
      ).toEqual(['q1', 'q2']);
    });

    it('finalizes BEFORE the post is created', async () => {
      await post();
      const order = fetchMock.mock.calls.map(([u]) => String(u));
      expect(order.findIndex((u) => u.includes('finalizeUpload'))).toBeLessThan(
        order.findIndex((u) => u.endsWith('/rest/posts')),
      );
    });

    it('posts the video URN as content.media.id, with the reshare choice and title', async () => {
      await post('Behind the bar');
      expect(postBody().content).toEqual({
        media: { id: 'urn:li:video:V1', title: 'Behind the bar' },
      });
      expect(postBody().isReshareDisabledByAuthor).toBe(true);
    });

    it('fails, in words, when a part comes back without an ETag', async () => {
      etags = ['etag-1', null];
      await expect(post()).rejects.toThrow(/ETag/);
      expect(
        fetchMock.mock.calls.some(([u]) =>
          String(u).includes('finalizeUpload'),
        ),
      ).toBe(false);
    });

    it('refuses a byte range outside the file', async () => {
      fetchMock.mockImplementationOnce(async () => ({
        ok: true,
        headers: headersOf({}),
        arrayBuffer: async () => new ArrayBuffer(100),
      }));
      await expect(post()).rejects.toThrow(/unusable upload part/);
    });

    it('refuses a video over 500 MB from its declared size, before buffering', async () => {
      const arrayBuffer = jest.fn();
      fetchMock.mockImplementationOnce(async () => ({
        ok: true,
        headers: headersOf({ 'content-length': String(501 * 1024 * 1024) }),
        arrayBuffer,
      }));
      await expect(post()).rejects.toThrow(/500 MB/);
      expect(arrayBuffer).not.toHaveBeenCalled();
    });
  });
});
