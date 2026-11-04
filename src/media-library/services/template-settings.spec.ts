import { BadRequestException, ValidationPipe } from '@nestjs/common';
import {
  CreateTemplateDto,
  MAX_TEMPLATE_FIRST_COMMENT_CHARS,
  UpdateTemplateDto,
} from '../dto/media-library.dto';
import { normalizeContent, TemplateService } from './template.service';

/**
 * "Save as template" keeps each channel's settings and first comments.
 *
 * `content` is a jsonb column, so storing them needs no schema change - the
 * obstacle was the DTO: `content` is validated as a nested class behind
 * `forbidNonWhitelisted`, so any key it was not told about came back 400.
 */

/** The app's global pipe (main.ts), so a body is read as the route reads it. */
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});

function asBody<T>(metatype: new () => T, value: unknown): Promise<T> {
  return pipe.transform(value, { type: 'body', metatype }) as Promise<T>;
}

const create = (content: Record<string, unknown>) =>
  asBody(CreateTemplateDto, {
    name: 'Launch',
    templateType: 'post',
    content: { text: 'Hi', ...content },
  });

const settings = {
  twitter: { madeWithAi: true, replyControl: 'following' },
  tiktok: { privacy: 'public', isAigc: true },
};

describe('the template body accepts what the composer keeps', () => {
  it('takes per-channel settings and first comments', async () => {
    const dto = await create({
      platformSettings: settings,
      firstComments: { instagram: '#coffee', linkedin: 'Link in comments' },
    });
    expect(dto.content.platformSettings).toEqual(settings);
    expect(dto.content.firstComments).toEqual({
      instagram: '#coffee',
      linkedin: 'Link in comments',
    });
  });

  it('keeps every key inside a channel’s settings, however new', async () => {
    // A channel's settings are the network's own `platformSpecific`, which a
    // publisher reads verbatim. Listing today's keys would reject tomorrow's.
    const dto = await create({
      platformSettings: {
        youtube: { somethingAddedNextMonth: { nested: [1, 2, 3] } },
      },
    });
    expect(dto.content.platformSettings?.youtube).toEqual({
      somethingAddedNextMonth: { nested: [1, 2, 3] },
    });
  });

  it('still accepts a template that keeps neither', async () => {
    const dto = await create({});
    expect(dto.content.platformSettings).toBeUndefined();
    expect(dto.content.firstComments).toBeUndefined();
  });

  it('takes them on an update too', async () => {
    const dto = await asBody(UpdateTemplateDto, {
      content: { text: 'Hi', platformSettings: settings },
    });
    expect(dto.content?.platformSettings).toEqual(settings);
  });

  it('still refuses a key of the content it was not told about', async () => {
    // The whitelist is the guard that made these two rows impossible, and it
    // must keep guarding everything else.
    await expect(create({ perChannel: {} })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

describe('platformSettings is refused when its shape is wrong', () => {
  it.each([
    ['an array', []],
    ['a string', 'twitter'],
    ['a number', 3],
    ['a channel whose settings are a string', { twitter: 'on' }],
    ['a channel whose settings are an array', { twitter: [] }],
    ['a channel whose settings are null', { twitter: null }],
    ['a platform nobody publishes to', { myspace: {} }],
  ])('%s', async (_name, platformSettings) => {
    await expect(create({ platformSettings })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('never lets a __proto__ key through to the column', async () => {
    // `JSON.parse` makes it an OWN property, as a request body would. The
    // pipe's class-transformer drops the key before validation sees it, so
    // what is left is an empty map - and the prototype is untouched. The
    // platform allow-list is the second line: `__proto__` is no platform.
    const platformSettings = JSON.parse('{"__proto__": {"polluted": true}}');
    const dto = await create({ platformSettings });
    expect(dto.content.platformSettings).toEqual({});
    expect(Object.keys(dto.content.platformSettings ?? {})).toEqual([]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('firstComments is refused when its shape is wrong', () => {
  it.each([
    ['an array', []],
    ['a string', 'hello'],
    ['a comment that is not a string', { instagram: 3 }],
    ['a comment that is null', { instagram: null }],
    ['a platform nobody publishes to', { myspace: 'hi' }],
    [
      'a comment longer than any network takes',
      { youtube: 'x'.repeat(MAX_TEMPLATE_FIRST_COMMENT_CHARS + 1) },
    ],
  ])('%s', async (_name, firstComments) => {
    await expect(create({ firstComments })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('takes a comment of exactly the limit', async () => {
    const youtube = 'x'.repeat(MAX_TEMPLATE_FIRST_COMMENT_CHARS);
    const dto = await create({ firstComments: { youtube } });
    expect(dto.content.firstComments?.youtube).toHaveLength(
      MAX_TEMPLATE_FIRST_COMMENT_CHARS,
    );
  });
});

describe('normalizeContent', () => {
  it('carries both onto what lands in the column', async () => {
    const dto = await create({
      platformSettings: settings,
      firstComments: { instagram: '#coffee' },
    });
    expect(normalizeContent(dto.content)).toMatchObject({
      text: 'Hi',
      platformSettings: settings,
      firstComments: { instagram: '#coffee' },
    });
  });

  it('leaves the keys out when the template keeps neither', async () => {
    // Not stored empty: the row then reads the same as one written before
    // these existed, so no reader has to tell the two apart.
    const stored = normalizeContent((await create({})).content);
    expect(stored).not.toHaveProperty('platformSettings');
    expect(stored).not.toHaveProperty('firstComments');
  });

  it('keeps the shape every older reader relies on', async () => {
    const stored = normalizeContent((await create({})).content);
    expect(stored.mediaSlots).toEqual([]);
    expect(stored.media).toEqual([]);
    expect(stored.hashtags).toEqual([]);
  });
});

describe('TemplateService writes them to the content column', () => {
  function service() {
    const inserted: any[] = [];
    const updated: any[] = [];
    const db = {
      insert: () => ({
        values: (v: unknown) => {
          inserted.push(v);
          return { returning: () => Promise.resolve([{ id: 't1' }]) };
        },
      }),
      update: () => ({
        set: (v: unknown) => {
          updated.push(v);
          return { where: () => Promise.resolve() };
        },
      }),
    };
    const svc = new TemplateService(db as never);
    jest.spyOn(svc, 'findOne').mockResolvedValue({ id: 't1' } as never);
    return { svc, inserted, updated };
  }

  it('on create', async () => {
    const { svc, inserted } = service();
    await svc.create(
      'w1',
      'u1',
      await create({
        platformSettings: settings,
        firstComments: { instagram: '#coffee' },
      }),
    );
    expect(inserted[0].content).toMatchObject({
      platformSettings: settings,
      firstComments: { instagram: '#coffee' },
    });
  });

  it('on update', async () => {
    const { svc, updated } = service();
    await svc.update(
      'w1',
      't1',
      await asBody(UpdateTemplateDto, {
        content: {
          text: 'Hi',
          platformSettings: settings,
          firstComments: { linkedin: 'x' },
        },
      }),
    );
    expect(updated[0].content).toMatchObject({
      platformSettings: settings,
      firstComments: { linkedin: 'x' },
    });
  });
});
