import { ilikePattern } from './search';

describe('ilikePattern', () => {
  it('escapes backslash, percent and underscore, then wraps in %', () => {
    expect(ilikePattern('50%_\\')).toBe('%50\\%\\_\\\\%');
  });

  it('wraps a plain term', () => {
    expect(ilikePattern('Sale')).toBe('%Sale%');
  });
});
