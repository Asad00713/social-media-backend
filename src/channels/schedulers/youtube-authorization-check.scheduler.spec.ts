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
const youtube = { checkAuthorization: jest.fn() };

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
    youtube.checkAuthorization
      .mockReset()
      .mockResolvedValue({ authorized: true, reason: 'ok' });
  });

  it('does nothing when there are no YouTube channels', async () => {
    connectedChannels([]);
    const scheduler = await build();
    await scheduler.verifyYoutubeAuthorizations();
    expect(youtube.checkAuthorization).not.toHaveBeenCalled();
  });

  it('leaves a still-authorized channel alone', async () => {
    connectedChannels([{ id: 1, workspace_id: 'ws' }]);
    youtube.checkAuthorization.mockResolvedValue({
      authorized: true,
      reason: 'ok',
    });
    const scheduler = await build();
    await scheduler.verifyYoutubeAuthorizations();
    expect(youtube.checkAuthorization).toHaveBeenCalledWith('TKN');
    expect(update).not.toHaveBeenCalled();
  });

  // The out-of-band revocation case: the user revoked us from Google's own
  // security settings, so nothing we do will ever succeed again. This is the
  // ONLY case that should flip the channel to 'expired'.
  it('marks a channel expired on a genuine authorization failure', async () => {
    connectedChannels([{ id: 1, workspace_id: 'ws' }]);
    youtube.checkAuthorization.mockResolvedValue({
      authorized: false,
      reason: 'unauthorized',
      message: 'HTTP 401',
    });
    const scheduler = await build();
    await scheduler.verifyYoutubeAuthorizations();
    expect(update).toHaveBeenCalled();
  });

  // CRITICAL regression case: a network blip / Google 5xx must NOT brick a
  // healthy channel. Before this fix, verifyToken collapsed this into the
  // same `false` as a genuine revocation.
  it('does NOT mark a channel expired on a network/server error', async () => {
    connectedChannels([{ id: 1, workspace_id: 'ws' }]);
    youtube.checkAuthorization.mockResolvedValue({
      authorized: false,
      reason: 'error',
      message: 'HTTP 500',
    });
    const scheduler = await build();
    await scheduler.verifyYoutubeAuthorizations();
    expect(update).not.toHaveBeenCalled();
  });

  // CRITICAL regression case: quota exhaustion (reserveQuota throwing inside
  // getCurrentChannel) must NOT be mistaken for revocation either.
  it('does NOT mark a channel expired on quota exhaustion', async () => {
    connectedChannels([{ id: 1, workspace_id: 'ws' }]);
    youtube.checkAuthorization.mockResolvedValue({
      authorized: false,
      reason: 'error',
      message:
        'YouTube publishing quota exhausted — skipping channels.list (0 units left)',
    });
    const scheduler = await build();
    await scheduler.verifyYoutubeAuthorizations();
    expect(update).not.toHaveBeenCalled();
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
    expect(youtube.checkAuthorization).toHaveBeenCalledWith('TKN2');
  });

  it('swallows a top-level failure rather than throwing', async () => {
    execute.mockRejectedValue(new Error('db is down'));
    const scheduler = await build();
    await expect(scheduler.verifyYoutubeAuthorizations()).resolves.toBeUndefined();
  });
});
