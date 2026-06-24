import { audienceToMetaTargeting } from './audience-to-targeting';

describe('audienceToMetaTargeting', () => {
  const base = { ageMin: 18, ageMax: 45, genders: ['all'] as const };

  it('maps countries when present', () => {
    const t = audienceToMetaTargeting({
      ...base,
      genders: ['all'],
      countries: ['US', 'PK'],
    });
    expect(t.geo_locations?.countries).toEqual(['US', 'PK']);
  });

  it('omits empty arrays so Meta does not reject', () => {
    const t = audienceToMetaTargeting({
      ...base,
      genders: ['all'],
      countries: [],
      cities: [],
      interests: [],
      behaviors: [],
      demographics: [],
      languages: [],
    });
    expect(t.geo_locations?.countries).toBeUndefined();
    expect(t.geo_locations?.cities).toBeUndefined();
    expect(t.interests).toBeUndefined();
    expect(t.behaviors).toBeUndefined();
    expect(t.family_statuses).toBeUndefined();
    expect(t.locales).toBeUndefined();
  });

  it('clamps age_min to 18 when interests are set', () => {
    const t = audienceToMetaTargeting({
      ageMin: 15,
      ageMax: 25,
      genders: ['all'],
      interests: [{ id: 'i1', name: 'Fashion' }],
    });
    expect(t.age_min).toBe(18);
  });

  it('clamps age_min to 18 when behaviors are set', () => {
    const t = audienceToMetaTargeting({
      ageMin: 16,
      ageMax: 25,
      genders: ['all'],
      behaviors: [{ id: 'b1', name: 'Online shoppers' }],
    });
    expect(t.age_min).toBe(18);
  });

  it('clamps age_min to 18 when demographics are set', () => {
    const t = audienceToMetaTargeting({
      ageMin: 13,
      ageMax: 25,
      genders: ['all'],
      demographics: [{ id: 'd1', name: 'Engaged' }],
    });
    expect(t.age_min).toBe(18);
  });

  it('maps "all" genders to undefined (no restriction)', () => {
    const t = audienceToMetaTargeting({ ...base, genders: ['all'] });
    expect(t.genders).toBeUndefined();
  });

  it('maps male+female to [1, 2]', () => {
    const t = audienceToMetaTargeting({ ...base, genders: ['male', 'female'] });
    expect(t.genders).toEqual([1, 2]);
  });

  it('defaults city radius to 10 miles when omitted', () => {
    const t = audienceToMetaTargeting({
      ...base,
      genders: ['all'],
      cities: [{ key: 'NYC' }],
    });
    expect(t.geo_locations?.cities).toEqual([
      { key: 'NYC', radius: 10, distance_unit: 'mile' },
    ]);
  });

  it('preserves caller-supplied city radius', () => {
    const t = audienceToMetaTargeting({
      ...base,
      genders: ['all'],
      cities: [{ key: 'NYC', radius: 25 }],
    });
    expect(t.geo_locations?.cities?.[0]?.radius).toBe(25);
  });

  it('maps languages to locales', () => {
    const t = audienceToMetaTargeting({
      ...base,
      genders: ['all'],
      languages: [6, 1031],
    });
    expect(t.locales).toEqual([6, 1031]);
  });

  it('maps demographics to family_statuses', () => {
    const t = audienceToMetaTargeting({
      ...base,
      genders: ['all'],
      demographics: [
        { id: 'd1', name: 'Engaged' },
        { id: 'd2', name: 'Newlyweds' },
      ],
    });
    expect(t.family_statuses).toEqual([
      { id: 'd1', name: 'Engaged' },
      { id: 'd2', name: 'Newlyweds' },
    ]);
  });

  it('omits geo_locations entirely when both countries and cities are empty', () => {
    const t = audienceToMetaTargeting({ ...base, genders: ['all'] });
    expect(t.geo_locations).toBeUndefined();
  });

  it('clamps age_max up to age_min when clamp inverts the range', () => {
    const t = audienceToMetaTargeting({
      ageMin: 15,
      ageMax: 17,
      genders: ['all'],
      interests: [{ id: 'i1', name: 'Fashion' }],
    });
    expect(t.age_min).toBe(18);
    expect(t.age_max).toBe(18);
  });

  it('always sets advantage_audience to 0 (off)', () => {
    const t = audienceToMetaTargeting({ ...base, genders: ['all'] });
    expect(t.targeting_automation).toEqual({ advantage_audience: 0 });
  });
});
