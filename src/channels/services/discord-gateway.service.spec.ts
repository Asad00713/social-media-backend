import { DiscordGatewayService } from './discord-gateway.service';

describe('DiscordGatewayService.shouldIngest', () => {
  // The queue dep is unused by shouldIngest (pure logic), so null is fine here.
  const svc = new DiscordGatewayService(null as any);
  const BOT = 'bot-1';

  it('ingests a DM to the bot (no guild)', () => {
    expect(
      svc.shouldIngest(
        { guild_id: undefined, author: { id: 'u1', bot: false }, mentions: [] },
        BOT,
      ),
    ).toBe(true);
  });

  it('ingests a guild message that @mentions the bot', () => {
    expect(
      svc.shouldIngest(
        { guild_id: 'g1', author: { id: 'u1', bot: false }, mentions: [{ id: BOT }] },
        BOT,
      ),
    ).toBe(true);
  });

  it('skips a guild message that does not mention the bot', () => {
    expect(
      svc.shouldIngest(
        { guild_id: 'g1', author: { id: 'u1', bot: false }, mentions: [] },
        BOT,
      ),
    ).toBe(false);
  });

  it('skips messages authored by the bot itself', () => {
    expect(
      svc.shouldIngest(
        { guild_id: undefined, author: { id: BOT, bot: true }, mentions: [] },
        BOT,
      ),
    ).toBe(false);
  });
});
