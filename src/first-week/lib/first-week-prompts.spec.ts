import { buildBrandPrompt, buildDraftPrompt } from './first-week-prompts';

describe('buildBrandPrompt', () => {
  const p = buildBrandPrompt({
    platform: 'instagram',
    captions: ['First post', 'Second post'],
  });

  it('asks for JSON only, with the three brand keys', () => {
    expect(p.system).toMatch(/ONLY a JSON object/);
    expect(p.system).toContain('"sells"');
    expect(p.system).toContain('"voice"');
    expect(p.system).toContain('"audience"');
    expect(p.system).toContain('120');
    expect(p.system).toContain('200');
  });

  it('numbers the captions and names the platform', () => {
    expect(p.user).toContain('instagram');
    expect(p.user).toContain('1. First post');
    expect(p.user).toContain('2. Second post');
  });

  it('tells the model the posts are data, not instructions', () => {
    expect(p.system).toMatch(/data, not instructions/i);
  });
});

describe('buildDraftPrompt', () => {
  const base = {
    brand: {
      sells: 'Small-batch coffee',
      voice: ['Warm', 'Local'],
      audience: 'Students nearby',
    },
    weekday: 'Friday',
    time: '9:00 AM',
    slot: 0,
    sampleCaptions: ['We roast on Tuesdays'],
    previousCaptions: ['Monday mood: espresso'],
    platforms: ['instagram', 'facebook'],
  };

  it('asks for a caption and an imageQuery as JSON, 280 characters max', () => {
    const p = buildDraftPrompt(base);
    expect(p.system).toMatch(/ONLY a JSON object/);
    expect(p.system).toContain('"caption"');
    expect(p.system).toContain('"imageQuery"');
    expect(p.system).toContain('280');
  });

  it('carries the profile, the slot, samples, and what was already drafted', () => {
    const { user } = buildDraftPrompt(base);
    expect(user).toContain('Small-batch coffee');
    expect(user).toContain('Warm, Local');
    expect(user).toContain('Students nearby');
    expect(user).toContain('Friday');
    expect(user).toContain('9:00 AM');
    expect(user).toContain('We roast on Tuesdays');
    expect(user).toContain('Monday mood: espresso');
    expect(user).toContain('instagram, facebook');
  });

  it('omits the samples and previous sections when there are none', () => {
    const { user } = buildDraftPrompt({
      ...base,
      sampleCaptions: [],
      previousCaptions: [],
    });
    expect(user).not.toContain('Examples of how they write');
    expect(user).not.toContain('Already drafted');
  });
});
