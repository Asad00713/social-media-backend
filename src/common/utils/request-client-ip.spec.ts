import { requestClientIp } from './request-client-ip';

describe('requestClientIp', () => {
  it('X-Real-IP wins over X-Forwarded-For (trimmed; first value of an array)', () => {
    expect(
      requestClientIp({
        headers: {
          'x-real-ip': ' 203.0.113.7 ',
          'x-forwarded-for': '1.1.1.1, 198.51.100.4',
        },
        ip: '10.0.0.2',
      }),
    ).toBe('203.0.113.7');
    expect(
      requestClientIp({
        headers: { 'x-real-ip': ['203.0.113.8', 'x'] },
        ip: '10.0.0.2',
      }),
    ).toBe('203.0.113.8');
  });

  it('without X-Real-IP uses the RIGHTMOST X-Forwarded-For entry', () => {
    expect(
      requestClientIp({
        headers: { 'x-forwarded-for': '1.1.1.1, 10.9.9.9 , 198.51.100.4 ' },
        ip: '10.0.0.2',
      }),
    ).toBe('198.51.100.4');
    expect(
      requestClientIp({
        headers: { 'x-forwarded-for': ['1.1.1.1', '198.51.100.9'] },
        ip: '10.0.0.2',
      }),
    ).toBe('198.51.100.9');
    expect(
      requestClientIp({
        headers: { 'x-forwarded-for': '198.51.100.4, ,' },
        ip: '10.0.0.2',
      }),
    ).toBe('198.51.100.4');
  });

  it('a spoofed leftmost X-Forwarded-For hop does not change the answer', () => {
    expect(
      requestClientIp({
        headers: { 'x-forwarded-for': '8.8.8.8, 7.7.7.7, 198.51.100.4' },
      }),
    ).toBe('198.51.100.4');
  });

  it('falls back to req.ip with no usable header, and null with nothing', () => {
    expect(requestClientIp({ headers: {}, ip: '192.0.2.1' })).toBe('192.0.2.1');
    expect(
      requestClientIp({
        headers: { 'x-real-ip': ' ', 'x-forwarded-for': ' , ' },
        ip: '192.0.2.1',
      }),
    ).toBe('192.0.2.1');
    expect(requestClientIp({ ip: '192.0.2.1' })).toBe('192.0.2.1');
    expect(requestClientIp({ headers: {} })).toBeNull();
    expect(requestClientIp({ headers: {}, ip: '' })).toBeNull();
  });

  it('a value that is not an IP address is null (never stored or looked up)', () => {
    expect(
      requestClientIp({ headers: { 'x-real-ip': 'not-an-ip' } }),
    ).toBeNull();
    expect(
      requestClientIp({
        headers: { 'x-real-ip': '1'.repeat(60) },
        ip: '192.0.2.1',
      }),
    ).toBeNull();
    expect(
      requestClientIp({ headers: { 'x-forwarded-for': '1.1.1.1, <script>' } }),
    ).toBeNull();
    expect(requestClientIp({ headers: {}, ip: '::ffff:999.1.1.1' })).toBeNull();
  });

  it('unmaps IPv4-in-IPv6 from any source', () => {
    expect(requestClientIp({ headers: {}, ip: '::ffff:192.0.2.1' })).toBe(
      '192.0.2.1',
    );
    expect(
      requestClientIp({ headers: { 'x-real-ip': '::ffff:203.0.113.7' } }),
    ).toBe('203.0.113.7');
    expect(requestClientIp({ headers: {}, ip: '2001:db8::1' })).toBe(
      '2001:db8::1',
    );
  });
});
