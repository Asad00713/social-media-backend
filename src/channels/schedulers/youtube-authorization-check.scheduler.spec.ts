import { Test } from '@nestjs/testing';
import { YoutubeAuthorizationCheckScheduler } from './youtube-authorization-check.scheduler';
import { ChannelService } from '../services/channel.service';
import { YouTubeService } from '../services/youtube.service';
import { DRIZZLE } from '../../drizzle/drizzle.module';

const execute = jest.fn();
const update = jest.fn();
const fakeDb = {
  execute,
  update: () => ({ set: () => ({ where: update }) }),
};
const channelService = { getAccessToken: jest.fn() };
const youtube = { verifyToken: jest.fn() };

async function build() {
  const mod = await Test.createTestingModule({
    providers: [
      YoutubeAuthorizationCheckScheduler,
      { provide: DRIZZLE, useValue: fakeDb },
      { provide: ChannelService, useValue: channelService },
      { provide: YouTubeService, useValue: youtube },
    ],
  }).compile();
  return mod.get(YoutubeAuthorizationCheckScheduler);
}

function connectedChannels(rows: Array<{ id: number; workspace_id: string }>) {
  execute.mockResolvedValue({ rows });
}

describe('YoutubeAuthorizationCheckScheduler', () => {
  beforeEach(() => {
    execute.mockReset();
    update.mockReset();
    channelService.getAccessToken.mockReset().mockResolvedValue('TKN');
    youtube.verifyToken.mockReset().mockResolvedValue(true);
  });

  it('does nothing when there are no YouTube channels', async () => {
    connectedChannels([]);
    const scheduler = await build();
    await scheduler.verifyYoutubeAuthorizations();
    expect(youtube.verifyToken).not.toHaveBeenCalled();
  });

  it('leaves a still-authorized channel alone', async () => {
    connectedChannels([{ id: 1, workspace_id: 'ws' }]);
    youtube.verifyToken.mockResolvedValue(true);
    const scheduler = await build();
    await scheduler.verifyYoutubeAuthorizations();
    expect(youtube.verifyToken).toHaveBeenCalledWith('TKN');
  });

  // The out-of-band revocation case: the user revoked us from Google's own
  // security settings, so nothing we do will ever succeed again.
  it('marks a channel expired when authorization is gone', async () => {
    connectedChannels([{ id: 1, workspace_id: 'ws' }]);
    youtube.verifyToken.mockResolvedValue(false);
    const scheduler = await build();
    await scheduler.verifyYoutubeAuthorizations();
    expect(update).toHaveBeenCalled();
  });

  // One bad channel must not stop the rest being checked — otherwise a single
  // broken channel silently ends re-verification for the whole install.
  it('continues checking other channels after one throws', async () => {
    connectedChannels([
      { id: 1, workspace_id: 'ws' },
      { id: 2, workspace_id: 'ws' },
    ]);
    channelService.getAccessToken
      .mockRejectedValueOnce(new Error('decrypt failed'))
      .mockResolvedValueOnce('TKN2');
    const scheduler = await build();
    await scheduler.verifyYoutubeAuthorizations();
    expect(youtube.verifyToken).toHaveBeenCalledWith('TKN2');
  });

  it('swallows a top-level failure rather than throwing', async () => {
    execute.mockRejectedValue(new Error('db is down'));
    const scheduler = await build();
    await expect(scheduler.verifyYoutubeAuthorizations()).resolves.toBeUndefined();
  });
});
