import { resolveRecipients } from './recipients';

const TEAM = [{ email: 'Owner@x.com' }, { email: 'Mate@x.com' }];

describe('resolveRecipients', () => {
  it('lists the team first, lowercased, then the others, each once', () => {
    expect(
      resolveRecipients(
        {
          sendToTeam: true,
          recipients: ['b@y.com', 'owner@x.com'],
          optedOut: [],
        },
        [{ email: 'Owner@x.com' }],
      ),
    ).toEqual(['owner@x.com', 'b@y.com']);
  });

  it('skips an opted-out address, a team member included', () => {
    expect(
      resolveRecipients(
        {
          sendToTeam: true,
          recipients: ['b@y.com', 'c@y.com'],
          optedOut: ['mate@x.com', 'c@y.com'],
        },
        TEAM,
      ),
    ).toEqual(['owner@x.com', 'b@y.com']);
  });

  it('ignores the team when sendToTeam is off', () => {
    expect(
      resolveRecipients(
        { sendToTeam: false, recipients: ['b@y.com'], optedOut: [] },
        TEAM,
      ),
    ).toEqual(['b@y.com']);
  });

  it('is empty when everyone opted out', () => {
    expect(
      resolveRecipients(
        { sendToTeam: false, recipients: ['b@y.com'], optedOut: ['b@y.com'] },
        TEAM,
      ),
    ).toEqual([]);
  });
});
