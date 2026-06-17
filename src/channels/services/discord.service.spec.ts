import { DiscordService } from './discord.service';

describe('DiscordService', () => {
  const svc = new DiscordService();

  it('builds a CDN avatar url from a user hash', () => {
    const url = svc.avatarUrl('123', 'abcd');
    expect(url).toBe('https://cdn.discordapp.com/avatars/123/abcd.png');
  });

  it('returns null avatar url when hash is null', () => {
    expect(svc.avatarUrl('123', null)).toBeNull();
  });
});
