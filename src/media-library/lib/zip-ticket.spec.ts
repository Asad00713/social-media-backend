import { createHmac } from 'crypto';
import {
  signZipTicket,
  verifyZipTicket,
  ZIP_TICKET_TTL_MS,
} from './zip-ticket';

const SECRET = 'a'.repeat(64);
const NOW = new Date('2026-01-15T12:00:00.000Z');
const PAYLOAD = {
  workspaceId: '11111111-1111-4111-8111-111111111111',
  categoryId: '22222222-2222-4222-8222-222222222222',
  userId: '33333333-3333-4333-8333-333333333333',
};

const at = (ms: number) => new Date(NOW.getTime() + ms);

describe('zip tickets', () => {
  it('round-trips the payload', () => {
    const { ticket } = signZipTicket(PAYLOAD, SECRET, NOW);
    expect(verifyZipTicket(ticket, SECRET, NOW)).toEqual({
      ...PAYLOAD,
      exp: NOW.getTime() + ZIP_TICKET_TTL_MS,
    });
  });

  it('expires five minutes after signing', () => {
    expect(ZIP_TICKET_TTL_MS).toBe(5 * 60 * 1000);
    const { expiresAt } = signZipTicket(PAYLOAD, SECRET, NOW);
    expect(expiresAt).toBe(at(5 * 60 * 1000).toISOString());
  });

  it('is valid at +4:59 and rejected at +5:00.001', () => {
    const { ticket } = signZipTicket(PAYLOAD, SECRET, NOW);
    expect(
      verifyZipTicket(ticket, SECRET, at(4 * 60 * 1000 + 59 * 1000)),
    ).not.toBeNull();
    expect(verifyZipTicket(ticket, SECRET, at(5 * 60 * 1000 + 1))).toBeNull();
  });

  it('rejects a ticket whose payload was altered', () => {
    const { ticket } = signZipTicket(PAYLOAD, SECRET, NOW);
    const [body, sig] = ticket.split('.');
    const i = 5;
    const flipped = body[i] === 'A' ? 'B' : 'A';
    const tampered = `${body.slice(0, i)}${flipped}${body.slice(i + 1)}.${sig}`;
    expect(verifyZipTicket(tampered, SECRET, NOW)).toBeNull();
  });

  it('rejects a ticket signed with another secret', () => {
    const { ticket } = signZipTicket(PAYLOAD, 'b'.repeat(64), NOW);
    expect(verifyZipTicket(ticket, SECRET, NOW)).toBeNull();
  });

  it.each(['', 'a.b.c', '!!.??', '.', 'abc'])('rejects malformed %p', (t) => {
    expect(verifyZipTicket(t, SECRET, NOW)).toBeNull();
  });

  it('rejects a correctly signed body that is not a ticket payload', () => {
    const body = Buffer.from(JSON.stringify({ workspaceId: 'w' })).toString(
      'base64url',
    );
    const sig = createHmac('sha256', SECRET).update(body).digest('base64url');
    expect(verifyZipTicket(`${body}.${sig}`, SECRET, NOW)).toBeNull();
  });

  it('never signs or verifies with an empty secret', () => {
    expect(() => signZipTicket(PAYLOAD, '', NOW)).toThrow();
    const { ticket } = signZipTicket(PAYLOAD, SECRET, NOW);
    expect(verifyZipTicket(ticket, '', NOW)).toBeNull();
  });
});
