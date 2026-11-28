import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { HomeSummaryQueryDto } from './dto/home-summary.dto';
import { HomeController } from './home.controller';
import type { HomeService } from './home.service';

// The app's global pipe (main.ts): bad query values are a 400.
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});
const parse = (query: object) =>
  pipe.transform(query, { type: 'query', metatype: HomeSummaryQueryDto });

describe('HomeSummaryQueryDto', () => {
  it('accepts no params: old clients keep working', async () => {
    const q = (await parse({})) as HomeSummaryQueryDto;
    expect(q.weekStart).toBeUndefined();
    expect(q.tz).toBeUndefined();
  });

  it.each(['monday', 'sunday', 'saturday'])(
    'accepts weekStart %s',
    async (w) => {
      expect(
        ((await parse({ weekStart: w })) as HomeSummaryQueryDto).weekStart,
      ).toBe(w);
    },
  );

  it.each(['friday', 'Monday', '', 'tuesday', '1'])(
    'rejects weekStart %p with a 400',
    async (w) => {
      await expect(parse({ weekStart: w })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    },
  );

  it.each(['Asia/Karachi', 'America/New_York', 'UTC'])(
    'accepts tz %s',
    async (tz) => {
      expect(((await parse({ tz })) as HomeSummaryQueryDto).tz).toBe(tz);
    },
  );

  it.each(['Mars/Olympus', '', 'utc+5', '+05:00', 'not a zone'])(
    'rejects tz %p with a 400',
    async (tz) => {
      await expect(parse({ tz })).rejects.toBeInstanceOf(BadRequestException);
    },
  );

  it('accepts both together', async () => {
    const q = (await parse({
      weekStart: 'sunday',
      tz: 'Asia/Karachi',
    })) as HomeSummaryQueryDto;
    expect(q).toMatchObject({ weekStart: 'sunday', tz: 'Asia/Karachi' });
  });
});

describe('HomeController.getSummary', () => {
  const makeController = () => {
    const home = { getSummary: jest.fn().mockResolvedValue({ ok: true }) };
    return {
      controller: new HomeController(home as unknown as HomeService),
      home,
    };
  };
  const WS = '8f6c1f0e-0000-4000-8000-000000000001';

  it('passes the week start and time zone through, leaving now to the service', async () => {
    const { controller, home } = makeController();
    await controller.getSummary(WS, {
      weekStart: 'sunday',
      tz: 'Asia/Karachi',
    });
    expect(home.getSummary).toHaveBeenCalledWith(WS, undefined, {
      weekStart: 'sunday',
      tz: 'Asia/Karachi',
    });
  });

  it('passes nothing when the params are absent', async () => {
    const { controller, home } = makeController();
    await controller.getSummary(WS, {});
    expect(home.getSummary).toHaveBeenCalledWith(WS, undefined, {
      weekStart: undefined,
      tz: undefined,
    });
  });
});
