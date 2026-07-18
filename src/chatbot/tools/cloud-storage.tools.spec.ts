import { createCloudStorageTools } from './cloud-storage.tools';

const channelService = { getWorkspaceChannels: jest.fn(), getAccessToken: jest.fn() } as any;
const onedrive = {} as any;
const dropbox = {} as any;
const photos = {} as any;

// Drive moved to the Google Picker under drive.file. A drive.file token cannot
// search a user's Drive, so this tool could only ever 403 — it must not exist.
it('exposes no Google Drive search tool', () => {
  const tools = createCloudStorageTools(channelService, onedrive, dropbox, photos);
  expect(tools.map((t) => t.name)).not.toContain('search_google_drive');
});

it('still exposes the other cloud search tools', () => {
  const tools = createCloudStorageTools(channelService, onedrive, dropbox, photos);
  expect(tools.map((t) => t.name).sort()).toEqual([
    'search_dropbox',
    'search_google_photos',
    'search_onedrive',
  ]);
});
