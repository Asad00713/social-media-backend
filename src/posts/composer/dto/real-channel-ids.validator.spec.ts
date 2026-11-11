import { BadRequestException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PublishDraftDto } from './publish-draft.dto';
import { ScheduleDraftDto } from './schedule-draft.dto';
import { isRealChannelId } from './real-channel-ids.validator';
import { ChannelCredentialsAdapter } from '../services/channel-credentials.adapter';
import type { ChannelService } from '../../../channels/services/channel.service';

/**
 * S3: an empty or 0 channel id is refused with a 400 that says so.
 *
 * A template applied in the composer used to put `channelId: ''`
 * placeholders on the draft, and `Number('')` is 0 - a finite number that
 * passed every check and was looked up as channel 0.
 */
const opts = { whitelist: true, forbidNonWhitelisted: true };
const draftId = '7f1f8f0e-3b7c-4d1a-9a55-0c2f7f4d6a10';
const base = { text: 'hi', mediaItems: [] };

const publishErrors = (channels: unknown[]) =>
  validate(plainToInstance(PublishDraftDto, { draftId, base, channels }), opts);

const scheduleErrors = (channels: unknown[]) =>
  validate(
    plainToInstance(ScheduleDraftDto, {
      draftId,
      base,
      channels,
      scheduledAt: '2026-12-01T09:00:00.000Z',
    }),
    opts,
  );

describe('real channel ids', () => {
  it.each(['', ' ', '0', '-3', '1.5', 'abc', null, undefined, 0, -1])(
    'isRealChannelId(%p) is false',
    (v) => {
      expect(isRealChannelId(v)).toBe(false);
    },
  );

  it.each(['7', ' 12 ', 7])('isRealChannelId(%p) is true', (v) => {
    expect(isRealChannelId(v)).toBe(true);
  });

  it.each([
    ['publish', publishErrors],
    ['schedule', scheduleErrors],
  ] as const)('%s refuses an empty channel id', async (_, check) => {
    const errors = await check([
      { channelId: '7', platform: 'facebook' },
      { channelId: '', platform: 'instagram' },
    ]);
    expect(errors.map((e) => e.property)).toEqual(['channels']);
    expect(Object.values(errors[0].constraints ?? {}).join()).toMatch(
      /real channel id/,
    );
  });

  it.each([
    ['publish', publishErrors],
    ['schedule', scheduleErrors],
  ] as const)('%s accepts real ids', async (_, check) => {
    expect(await check([{ channelId: '7', platform: 'facebook' }])).toEqual([]);
  });

  it('the credentials lookup refuses channel 0 before touching the database', async () => {
    const getChannelById = jest.fn();
    const adapter = new ChannelCredentialsAdapter({
      getChannelById,
      getAccessToken: jest.fn(),
    } as unknown as ChannelService);

    await expect(adapter.getCredentials('ws', '')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(adapter.getCredentials('ws', '0')).rejects.toThrow(
      /real channel id/,
    );
    expect(getChannelById).not.toHaveBeenCalled();
  });
});
