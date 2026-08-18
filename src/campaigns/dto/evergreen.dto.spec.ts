import 'reflect-metadata';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import {
  CreateEvergreenCategoryDto,
  CreateEvergreenCampaignDto,
  RecyclePolicyDto,
} from './evergreen.dto';

describe('CreateEvergreenCategoryDto', () => {
  it('accepts a valid category', async () => {
    const dto = plainToInstance(CreateEvergreenCategoryDto, {
      name: 'Tips',
      color: 'emerald',
      schedule: { weekdays: [1, 3], times: ['09:00'] },
      channelIds: ['12'],
    });
    expect(await validate(dto)).toHaveLength(0);
  });

  it('rejects an empty name', async () => {
    const dto = plainToInstance(CreateEvergreenCategoryDto, {
      name: '',
      color: 'emerald',
      schedule: { weekdays: [1], times: ['09:00'] },
      channelIds: [],
    });
    expect((await validate(dto)).length).toBeGreaterThan(0);
  });

  it('rejects an invalid color', async () => {
    const dto = plainToInstance(CreateEvergreenCategoryDto, {
      name: 'Tips',
      color: 'magenta',
      schedule: { weekdays: [1], times: ['09:00'] },
      channelIds: ['12'],
    });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.property === 'color')).toBe(true);
  });

  it('rejects an invalid weekday and time format in schedule', async () => {
    const dto = plainToInstance(CreateEvergreenCategoryDto, {
      name: 'Tips',
      color: 'emerald',
      schedule: { weekdays: [7], times: ['9am'] },
      channelIds: ['12'],
    });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe('CreateEvergreenCampaignDto', () => {
  it('requires name, startDate, timezone', async () => {
    const dto = plainToInstance(CreateEvergreenCampaignDto, {
      name: 'X',
      startDate: '2026-08-20',
      timezone: 'UTC',
      channelIds: ['1'],
    });
    expect(await validate(dto)).toHaveLength(0);
  });

  it('rejects a missing startDate', async () => {
    const dto = plainToInstance(CreateEvergreenCampaignDto, {
      name: 'X',
      timezone: 'UTC',
      channelIds: ['1'],
    });
    expect((await validate(dto)).length).toBeGreaterThan(0);
  });
});

describe('RecyclePolicyDto', () => {
  it('accepts mode=forever with no maxCount/expiryDate', async () => {
    const dto = plainToInstance(RecyclePolicyDto, { mode: 'forever' });
    expect(await validate(dto)).toHaveLength(0);
  });

  it('accepts mode=maxCount with a valid maxCount', async () => {
    const dto = plainToInstance(RecyclePolicyDto, { mode: 'maxCount', maxCount: 5 });
    expect(await validate(dto)).toHaveLength(0);
  });

  it('accepts mode=expiry with a valid expiryDate', async () => {
    const dto = plainToInstance(RecyclePolicyDto, { mode: 'expiry', expiryDate: '2026-12-31' });
    expect(await validate(dto)).toHaveLength(0);
  });

  it('rejects an invalid mode', async () => {
    const dto = plainToInstance(RecyclePolicyDto, { mode: 'never' });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.property === 'mode')).toBe(true);
  });

  it('rejects a maxCount below 1', async () => {
    const dto = plainToInstance(RecyclePolicyDto, { mode: 'maxCount', maxCount: 0 });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });
});
