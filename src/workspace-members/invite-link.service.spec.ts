import {
  generateInviteCode,
  INVITE_CODE_ALPHABET,
  INVITE_CODE_REGEX,
  InviteLinkService,
} from './invite-link.service';

describe('generateInviteCode', () => {
  const zeros = (n: number) => Buffer.alloc(n, 0);

  it('starts with the first letters of the first two words, lowercased', () => {
    expect(generateInviteCode('Rehman Works', zeros)).toMatch(/^rw-/);
    expect(generateInviteCode('Acme', zeros)).toMatch(/^a-/);
    expect(generateInviteCode('  the  Big   Co ', zeros)).toMatch(/^tb-/);
  });

  it('takes the first ASCII letter or digit of a word', () => {
    expect(generateInviteCode('"Hello" (World)', zeros)).toMatch(/^hw-/);
    expect(generateInviteCode('3 Sisters Bakery', zeros)).toMatch(/^3s-/);
  });

  it('falls back to ws when no word has an ASCII letter or digit', () => {
    expect(generateInviteCode('  ', zeros)).toMatch(/^ws-/);
    expect(generateInviteCode('', zeros)).toMatch(/^ws-/);
    expect(generateInviteCode('!!! ???', zeros)).toMatch(/^ws-/);
    expect(generateInviteCode('\u65e5\u672c', zeros)).toMatch(/^ws-/);
  });

  it('maps ten random bytes onto the Crockford base32 alphabet', () => {
    const bytes = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const code = generateInviteCode('Rehman Works', () => bytes);
    expect(code).toBe('rw-0123456789');
    // 31 is the last symbol; the top bits of a byte are dropped, not biased.
    const top = generateInviteCode('Rehman Works', () =>
      Buffer.alloc(10, 0xff),
    );
    expect(top).toBe('rw-zzzzzzzzzz');
  });

  it('asks the random source for exactly the bytes it needs', () => {
    const random = jest.fn((n: number) => Buffer.alloc(n, 7));
    generateInviteCode('Rehman Works', random);
    expect(random).toHaveBeenCalledTimes(1);
    expect(random).toHaveBeenCalledWith(10);
  });

  it('uses the alphabet without I, L, O and U', () => {
    expect(INVITE_CODE_ALPHABET).toBe('0123456789abcdefghjkmnpqrstvwxyz');
    expect(INVITE_CODE_ALPHABET).toHaveLength(32);
  });

  it('1,000 generated codes all match the format and none repeat', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const code = generateInviteCode('Rehman Works');
      expect(code).toMatch(INVITE_CODE_REGEX);
      seen.add(code);
    }
    expect(seen.size).toBe(1000);
  });
});

describe('INVITE_CODE_REGEX', () => {
  it.each(['rw-0123456789', 'a-zzzzzzzzzz', 'ws-0abcdefghj'])(
    'accepts %s',
    (code) => {
      expect(INVITE_CODE_REGEX.test(code)).toBe(true);
    },
  );

  it.each([
    '',
    'rw-012345678', // 9 chars
    'rw-01234567890', // 11 chars
    'rwx-0123456789', // 3 initials
    '-0123456789', // no initials
    'RW-0123456789', // upper case
    'rw-012345678i', // i is not in the alphabet
    'rw-012345678l',
    'rw-012345678o',
    'rw-012345678u',
    'rw_0123456789',
    'rw-0123456789\n',
    'rw-0123456789 ',
  ])('rejects %p', (code) => {
    expect(INVITE_CODE_REGEX.test(code)).toBe(false);
  });
});

describe('InviteLinkService code collisions', () => {
  const collision = () =>
    Object.assign(new Error('Failed query'), { cause: { code: '23505' } });

  function build(returning: jest.Mock) {
    const db = {
      query: {
        workspace: {
          findFirst: jest.fn().mockResolvedValue({ name: 'Rehman Works' }),
        },
      },
      update: jest.fn(() => ({
        set: jest.fn(() => ({ where: jest.fn(() => ({ returning })) })),
      })),
    };
    const links = { frontend: (path: string) => `https://app.test${path}` };
    return new InviteLinkService(
      db as never,
      {} as never,
      {} as never,
      links as never,
    );
  }

  it('retries once with a new code when the unique index objects', async () => {
    const returning = jest
      .fn()
      .mockRejectedValueOnce(collision())
      .mockResolvedValueOnce([
        { inviteLinkCode: 'rw-0123456789', inviteLinkEnabled: true },
      ]);
    const service = build(returning);

    await expect(service.reset('ws-1')).resolves.toEqual({
      enabled: true,
      url: 'https://app.test/join/rw-0123456789',
    });
    expect(returning).toHaveBeenCalledTimes(2);
  });

  it('gives up after the second collision rather than loop', async () => {
    const returning = jest.fn().mockRejectedValue(collision());
    const service = build(returning);

    await expect(service.reset('ws-1')).rejects.toThrow('Failed query');
    expect(returning).toHaveBeenCalledTimes(2);
  });

  it('does not retry an error that is not a unique violation', async () => {
    const returning = jest.fn().mockRejectedValue(new Error('connection lost'));
    const service = build(returning);

    await expect(service.reset('ws-1')).rejects.toThrow('connection lost');
    expect(returning).toHaveBeenCalledTimes(1);
  });
});
