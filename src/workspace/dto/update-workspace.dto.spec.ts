import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateWorkspaceDto } from './update-workspace.dto';
import { PresignLogoDto } from './presign-logo.dto';

const errorsFor = async (body: object) =>
  (await validate(plainToInstance(UpdateWorkspaceDto, body))).map(
    (e) => e.property,
  );

describe('UpdateWorkspaceDto', () => {
  it('accepts an empty body: every field is optional', async () => {
    expect(await errorsFor({})).toEqual([]);
  });

  describe('timezone', () => {
    it('accepts UTC, which not every Node build lists', async () => {
      expect(await errorsFor({ timezone: 'UTC' })).toEqual([]);
    });

    it('accepts an IANA zone', async () => {
      expect(await errorsFor({ timezone: 'Asia/Karachi' })).toEqual([]);
    });

    it.each(['Mars/X', '+05:00', '', 'asia karachi'])(
      'rejects %p',
      async (timezone) => {
        expect(await errorsFor({ timezone })).toContain('timezone');
      },
    );

    it('rejects null: the column is NOT NULL', async () => {
      expect(await errorsFor({ timezone: null })).toContain('timezone');
    });
  });

  describe('logo', () => {
    it('accepts null, which clears the logo', async () => {
      expect(await errorsFor({ logo: null })).toEqual([]);
    });

    it('accepts a URL', async () => {
      expect(
        await errorsFor({ logo: 'https://cdn.example.test/a.png' }),
      ).toEqual([]);
    });

    it.each(['not a url', '', 7])('rejects %p', async (logo) => {
      expect(await errorsFor({ logo })).toContain('logo');
    });
  });

  describe('approvalPolicy', () => {
    it.each(['none', 'members', 'everyone'])('accepts %s', async (p) => {
      expect(await errorsFor({ approvalPolicy: p })).toEqual([]);
    });

    it.each(['some', '', 'NONE', null, 1])('rejects %p', async (p) => {
      expect(await errorsFor({ approvalPolicy: p })).toContain(
        'approvalPolicy',
      );
    });
  });

  describe.each([
    'shortenLinksDefault',
    'utmDefault',
    'applyTimezoneToChannels',
  ])('%s', (field) => {
    it.each([true, false])('accepts %p', async (v) => {
      expect(await errorsFor({ [field]: v })).toEqual([]);
    });

    it.each(['true', 1, null])('rejects %p', async (v) => {
      expect(await errorsFor({ [field]: v })).toContain(field);
    });
  });

  it('still limits the name to 40 characters', async () => {
    expect(await errorsFor({ name: 'a'.repeat(41) })).toContain('name');
    expect(await errorsFor({ name: 'a'.repeat(40) })).toEqual([]);
  });
});

describe('PresignLogoDto', () => {
  const presignErrors = async (body: object) =>
    (await validate(plainToInstance(PresignLogoDto, body))).map(
      (e) => e.property,
    );

  it.each(['image/png', 'image/jpeg'])('accepts %s at 2 MB', async (t) => {
    expect(
      await presignErrors({ contentType: t, sizeBytes: 2 * 1024 * 1024 }),
    ).toEqual([]);
  });

  it.each(['image/webp', 'image/gif', 'application/pdf'])(
    'rejects %s',
    async (t) => {
      expect(
        await presignErrors({ contentType: t, sizeBytes: 1024 }),
      ).toContain('contentType');
    },
  );

  it('rejects a file over 2 MB, an empty one and a fractional size', async () => {
    const ok = { contentType: 'image/png' };
    expect(
      await presignErrors({ ...ok, sizeBytes: 2 * 1024 * 1024 + 1 }),
    ).toContain('sizeBytes');
    expect(await presignErrors({ ...ok, sizeBytes: 0 })).toContain('sizeBytes');
    expect(await presignErrors({ ...ok, sizeBytes: 1.5 })).toContain(
      'sizeBytes',
    );
  });
});
