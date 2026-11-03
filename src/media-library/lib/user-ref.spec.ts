import { toUserRef } from './user-ref';

describe('toUserRef', () => {
  it('falls back to the email local part when the name is null', () => {
    expect(
      toUserRef({ id: 'u1', name: null, email: 'sam@x.io', avatarUrl: null }),
    ).toEqual({ id: 'u1', name: 'sam', avatarUrl: null });
  });

  it('keeps a real name and avatar', () => {
    expect(
      toUserRef({
        id: 'u2',
        name: 'Ada Lovelace',
        email: 'ada@x.io',
        avatarUrl: 'https://cdn.x.io/a.png',
      }),
    ).toEqual({
      id: 'u2',
      name: 'Ada Lovelace',
      avatarUrl: 'https://cdn.x.io/a.png',
    });
  });

  it('maps null to null', () => {
    expect(toUserRef(null)).toBeNull();
  });
});

describe('toUserRef with an empty name', () => {
  it('falls back to the email local part', () => {
    expect(
      toUserRef({ id: 'u3', name: '', email: 'kim@x.io', avatarUrl: null }),
    ).toEqual({ id: 'u3', name: 'kim', avatarUrl: null });
  });
});
