import {
  LlmOutputError,
  normaliseBrand,
  parseBrandJson,
  parseDraftJson,
} from './first-week-parse';

const FENCE = '`'.repeat(3);

describe('parseBrandJson', () => {
  const good = {
    sells: 'Small-batch coffee',
    voice: ['warm', 'local', 'playful'],
    audience: 'Students and young professionals nearby',
  };

  it('accepts clean JSON', () => {
    expect(parseBrandJson(JSON.stringify(good))).toEqual(good);
  });

  it('accepts JSON inside a markdown fence', () => {
    const raw = `${FENCE}json\n${JSON.stringify(good)}\n${FENCE}`;
    expect(parseBrandJson(raw)).toEqual(good);
  });

  it('accepts JSON wrapped in prose', () => {
    const raw = `Sure! Here is the profile:\n${JSON.stringify(good)}\nHope that helps.`;
    expect(parseBrandJson(raw)).toEqual(good);
  });

  it('rejects text with no JSON object', () => {
    expect(() => parseBrandJson('I could not tell.')).toThrow(LlmOutputError);
    expect(() => parseBrandJson('')).toThrow(LlmOutputError);
  });

  it('rejects malformed JSON', () => {
    expect(() => parseBrandJson('{"sells": "x",')).toThrow(LlmOutputError);
    expect(() => parseBrandJson('{sells: x}')).toThrow(LlmOutputError);
  });

  it('rejects a JSON array or primitive at the top level', () => {
    expect(() => parseBrandJson('[1,2]')).toThrow(LlmOutputError);
  });

  it('rejects an empty voice list and missing fields', () => {
    expect(() =>
      parseBrandJson(JSON.stringify({ ...good, voice: [] })),
    ).toThrow(LlmOutputError);
    expect(() =>
      parseBrandJson(JSON.stringify({ ...good, sells: '  ' })),
    ).toThrow(LlmOutputError);
    expect(() =>
      parseBrandJson(JSON.stringify({ sells: 'x', voice: ['a'] })),
    ).toThrow(LlmOutputError);
  });

  it('rejects a voice that is a string, not an array', () => {
    expect(() =>
      parseBrandJson(JSON.stringify({ ...good, voice: 'warm' })),
    ).toThrow(LlmOutputError);
  });

  it('clips over-long text to the spec limits and caps voice at 5 chips of 24 characters', () => {
    const out = parseBrandJson(
      JSON.stringify({
        sells: 's'.repeat(300),
        voice: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
        audience: 'u'.repeat(500),
      }),
    );
    expect(out.sells).toHaveLength(120);
    expect(out.audience).toHaveLength(200);
    expect(out.voice).toEqual(['a', 'b', 'c', 'd', 'e']);

    const wide = parseBrandJson(
      JSON.stringify({ ...good, voice: ['x'.repeat(40)] }),
    );
    expect(wide.voice[0]).toHaveLength(24);
  });

  it('dedupes voice chips case-insensitively and drops blanks and non-strings', () => {
    const out = parseBrandJson(
      JSON.stringify({
        ...good,
        voice: ['Warm', 'warm', ' ', 7, null, 'Local'],
      }),
    );
    expect(out.voice).toEqual(['Warm', 'Local']);
  });
});

describe('normaliseBrand', () => {
  it('trims user input the same way', () => {
    expect(
      normaliseBrand({
        sells: '  tea  ',
        voice: [' calm '],
        audience: ' everyone ',
      }),
    ).toEqual({ sells: 'tea', voice: ['calm'], audience: 'everyone' });
  });
});

describe('parseDraftJson', () => {
  it('accepts caption and imageQuery', () => {
    expect(
      parseDraftJson(
        '{"caption":"Fresh beans today","imageQuery":"coffee beans"}',
      ),
    ).toEqual({ caption: 'Fresh beans today', imageQuery: 'coffee beans' });
  });

  it('accepts a fenced answer', () => {
    const raw = `${FENCE}json\n{"caption":"Hi","imageQuery":"smile"}\n${FENCE}`;
    expect(parseDraftJson(raw).caption).toBe('Hi');
  });

  it('treats a missing imageQuery as "no image wanted"', () => {
    expect(parseDraftJson('{"caption":"Hi"}')).toEqual({
      caption: 'Hi',
      imageQuery: '',
    });
  });

  it('rejects an empty caption', () => {
    expect(() => parseDraftJson('{"caption":"  ","imageQuery":"x"}')).toThrow(
      LlmOutputError,
    );
    expect(() => parseDraftJson('{"imageQuery":"x"}')).toThrow(LlmOutputError);
  });

  it('rejects a caption over 280 characters (it would not fit every platform)', () => {
    const long = JSON.stringify({ caption: 'x'.repeat(281), imageQuery: 'y' });
    expect(() => parseDraftJson(long)).toThrow(LlmOutputError);
    const ok = JSON.stringify({ caption: 'x'.repeat(280), imageQuery: 'y' });
    expect(parseDraftJson(ok).caption).toHaveLength(280);
  });

  it('clips an over-long imageQuery to 80 characters', () => {
    const out = parseDraftJson(
      JSON.stringify({ caption: 'Hi', imageQuery: 'q'.repeat(200) }),
    );
    expect(out.imageQuery).toHaveLength(80);
  });
});
