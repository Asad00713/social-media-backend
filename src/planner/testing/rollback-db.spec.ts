import { assertLocalDatabase } from './rollback-db';

describe('assertLocalDatabase', () => {
  it('accepts plain localhost', () => {
    const url = 'postgres://u@localhost:5432/db';
    expect(assertLocalDatabase(url, {})).toBe(url);
    expect(assertLocalDatabase('postgres://u@127.0.0.1/db', {})).toBeTruthy();
  });

  it('refuses a non-local host', () => {
    expect(() =>
      assertLocalDatabase('postgres://u@prod.example.com/db', {}),
    ).toThrow(/non-local/);
  });

  it('refuses host= and hostaddr= overrides', () => {
    expect(() =>
      assertLocalDatabase(
        'postgres://u@localhost/db?host=prod.example.com',
        {},
      ),
    ).toThrow(/override/);
    expect(() =>
      assertLocalDatabase('postgres://u@localhost/db?hostaddr=10.0.0.1', {}),
    ).toThrow(/override/);
  });

  it('refuses a non-local PGHOST but allows a local one', () => {
    const url = 'postgres://u@localhost/db';
    expect(() =>
      assertLocalDatabase(url, { PGHOST: 'prod.example.com' }),
    ).toThrow(/PGHOST/);
    expect(assertLocalDatabase(url, { PGHOST: '127.0.0.1' })).toBe(url);
  });

  it('refuses a non-local PGHOSTADDR but allows 127.0.0.1', () => {
    const url = 'postgres://u@localhost/db';
    expect(() => assertLocalDatabase(url, { PGHOSTADDR: '10.0.0.1' })).toThrow(
      /PGHOSTADDR/,
    );
    expect(assertLocalDatabase(url, { PGHOSTADDR: '127.0.0.1' })).toBe(url);
  });
});
