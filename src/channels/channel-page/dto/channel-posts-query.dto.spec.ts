import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { ChannelPostsQueryDto } from './channel-page.dto';

// The global pipe, as main.ts configures it.
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});
const validate = (query: unknown) =>
  pipe.transform(query, {
    type: 'query',
    metatype: ChannelPostsQueryDto,
  }) as Promise<ChannelPostsQueryDto>;

const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';

describe('ChannelPostsQueryDto', () => {
  it('splits csv filters and reads the limit as a number', async () => {
    await expect(
      validate({
        tab: 'sent',
        format: 'reel, image',
        createdBy: `${U1},${U2}`,
        sort: 'engagementRate',
        limit: '50',
      }),
    ).resolves.toMatchObject({
      tab: 'sent',
      format: ['reel', 'image'],
      createdBy: [U1, U2],
      sort: 'engagementRate',
      limit: 50,
    });
  });

  it('an empty filter is no filter', async () => {
    const q = await validate({ format: '', createdBy: '' });
    expect(q.format).toBeUndefined();
    expect(q.createdBy).toBeUndefined();
  });

  it.each([
    [{ tab: 'all' }, 'tab'],
    [{ format: 'image,gif' }, 'format'],
    [{ createdBy: 'maestro' }, 'createdBy'],
    [{ sort: 'views' }, 'sort'],
    [{ sort: 'time,likes' }, 'sort'],
    [{ limit: '51' }, 'limit'],
    [{ limit: '0' }, 'limit'],
    [{ cursor: 'a b' }, 'cursor'],
    [{ channelId: '3' }, 'channelId'],
  ])('refuses %o', async (query, field) => {
    const err: unknown = await validate(query).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(
      JSON.stringify((err as BadRequestException).getResponse()),
    ).toContain(field);
  });
});
