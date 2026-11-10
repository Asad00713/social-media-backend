import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ScheduleDraftDto } from './schedule-draft.dto';

/** The app's ValidationPipe: whitelist + forbidNonWhitelisted (main.ts). */
const check = (body: Record<string, unknown>) =>
  validate(plainToInstance(ScheduleDraftDto, body), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });

const body = {
  draftId: '7f1f8f0e-3b7c-4d1a-9a55-0c2f7f4d6a10',
  scheduledAt: '2026-10-15T04:30:00.000Z',
  base: { text: 'Iced latte is {back|here again}', mediaItems: [] },
  channels: [{ channelId: '7', platform: 'facebook' }],
  recurrence: {
    freq: 'weekly',
    interval: 1,
    ends: { type: 'never' },
    rotateVariations: true,
  },
};

describe('ScheduleDraftDto — "Use your variations"', () => {
  it('accepts variationSources (an older API refused the whole request)', async () => {
    const errors = await check({
      ...body,
      variationSources: {
        facebook: { text: 'Iced latte is {back|here again}', index: 0 },
      },
    });
    expect(errors).toEqual([]);
  });

  it('refuses variationSources that is not an object', async () => {
    const errors = await check({ ...body, variationSources: 'x' });
    expect(errors.map((e) => e.property)).toEqual(['variationSources']);
  });
});
