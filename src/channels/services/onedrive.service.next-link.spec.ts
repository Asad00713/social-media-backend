import { BadRequestException } from '@nestjs/common';
import { OneDriveService } from './onedrive.service';

// The legacy /channels/onedrive/* routes take Graph's `nextLink` from the
// request body and fetch it with the bearer token. Only a Graph URL may be
// followed; anything else is refused before a request is made.
describe('OneDriveService nextLink', () => {
  const service = new OneDriveService();
  let globalFetch: jest.SpyInstance;
  beforeEach(() => {
    globalFetch = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ value: [] }), {
        headers: { 'content-type': 'application/json' },
      }),
    );
  });
  afterEach(() => jest.restoreAllMocks());

  const CALLS: [string, (nextLink: string) => Promise<unknown>][] = [
    ['listItems', (nextLink) => service.listItems('tok', { nextLink })],
    ['listMedia', (nextLink) => service.listMedia('tok', { nextLink })],
    ['listImages', (nextLink) => service.listImages('tok', { nextLink })],
    ['listVideos', (nextLink) => service.listVideos('tok', { nextLink })],
    ['listFolders', (nextLink) => service.listFolders('tok', { nextLink })],
    [
      'searchFiles',
      (nextLink) => service.searchFiles('tok', 'cat', { nextLink }),
    ],
  ];

  describe.each(CALLS)('%s', (_name, call) => {
    it.each([
      'http://169.254.169.254/latest/meta-data/',
      'http://localhost:6379/',
      'https://attacker.example/collect',
      'https://graph.microsoft.com.attacker.example/v1.0/me',
      'not a url',
    ])('refuses %s and sends nothing', async (nextLink) => {
      await expect(call(nextLink)).rejects.toBeInstanceOf(BadRequestException);
      expect(globalFetch).not.toHaveBeenCalled();
    });

    it('follows a Graph nextLink', async () => {
      const link =
        'https://graph.microsoft.com/v1.0/me/drive/root/children?$skiptoken=x';
      await call(link).catch(() => undefined);
      expect(globalFetch).toHaveBeenCalledWith(link, expect.anything());
    });
  });
});
