import {
  FEATURE_MIN_PLAN,
  PLAN_RANK,
  featuresForPlan,
  planAllows,
  toPlanCode,
  type PlanCode,
  type PlanFeature,
} from './plan-features';

const ALL_FEATURES = Object.keys(FEATURE_MIN_PLAN) as PlanFeature[];
const ALL_PLANS = Object.keys(PLAN_RANK) as PlanCode[];

describe('plan feature gating', () => {
  it('a plan includes everything the tiers below it include', () => {
    // The whole point of a ranked map: upgrading never takes a feature away.
    // Without this, a feature could be granted to BASIC and MAX but not PRO,
    // and a PRO customer would watch a capability vanish when they upgraded.
    for (const feature of ALL_FEATURES) {
      const allowed = ALL_PLANS.filter((p) => planAllows(p, feature)).map(
        (p) => PLAN_RANK[p],
      );
      const lowest = Math.min(...allowed);
      for (const plan of ALL_PLANS) {
        if (PLAN_RANK[plan] >= lowest) {
          expect(planAllows(plan, feature)).toBe(true);
        }
      }
    }
  });

  it('FREE gets none of the gated features', () => {
    // If a feature is in this map at all, it is because it costs money or is
    // an upmarket feature. A FREE entry would mean the map has an entry that
    // gates nothing, which is worse than no entry: it reads as enforcement.
    for (const feature of ALL_FEATURES) {
      expect(planAllows('FREE', feature)).toBe(false);
    }
  });

  it('ENTERPRISE gets everything', () => {
    for (const feature of ALL_FEATURES) {
      expect(planAllows('ENTERPRISE', feature)).toBe(true);
    }
  });

  it('gates the features the agreed matrix puts behind Basic', () => {
    // Pinned against schedura-landing/docs/plan-feature-matrix.md. These are
    // the lines the marketing site sells, so a silent change here would make
    // the site advertise something the app refuses.
    for (const feature of [
      'inbox:use',
      'campaigns:drip',
      'campaigns:multi-channel',
      'library:canva-import',
    ] as PlanFeature[]) {
      expect(planAllows('FREE', feature)).toBe(false);
      expect(planAllows('BASIC', feature)).toBe(true);
    }
  });

  it('gates the features the agreed matrix puts behind Pro', () => {
    for (const feature of [
      'maestro:use',
      'calendar:sync',
      'campaigns:evergreen',
      'insights:export',
      'insights:scheduled-reports',
      'ads:use',
      'posts:approval-workflow',
      'brand:kit',
    ] as PlanFeature[]) {
      expect(planAllows('BASIC', feature)).toBe(false);
      expect(planAllows('PRO', feature)).toBe(true);
    }
  });

  it('an unknown plan code is treated as FREE, not as a pass', () => {
    // A guard resolves a plan code from the database. A typo, a renamed tier
    // or a NULL must refuse a paid feature rather than hand it out — the
    // opposite of getPlanLimits, which falls back to limits so a missing row
    // cannot stop a paying customer from publishing.
    for (const code of ['', null, undefined, 'GOLD', 'free ', 'PRO_LEGACY']) {
      expect(toPlanCode(code)).toBe('FREE');
    }
  });

  it('accepts a known code in any case', () => {
    expect(toPlanCode('pro')).toBe('PRO');
    expect(toPlanCode('Max')).toBe('MAX');
    expect(toPlanCode('BASIC')).toBe('BASIC');
  });

  it('featuresForPlan agrees with planAllows', () => {
    // The entitlements endpoint serves this list and the guard uses
    // planAllows. If they ever disagree the UI shows a lock on something the
    // API permits, or offers something it refuses.
    for (const plan of ALL_PLANS) {
      const listed = featuresForPlan(plan);
      for (const feature of ALL_FEATURES) {
        expect(listed.includes(feature)).toBe(planAllows(plan, feature));
      }
    }
  });

  it('featuresForPlan grows with the tier', () => {
    const counts = ALL_PLANS.sort((a, b) => PLAN_RANK[a] - PLAN_RANK[b]).map(
      (p) => featuresForPlan(p).length,
    );
    expect(counts).toEqual([...counts].sort((a, b) => a - b));
    expect(counts[0]).toBe(0);
    expect(counts[counts.length - 1]).toBe(ALL_FEATURES.length);
  });

  it('every feature names a plan that exists', () => {
    // A tier typo in FEATURE_MIN_PLAN would make PLAN_RANK[...] undefined, and
    // `>= undefined` is false for every plan — silently gating the feature off
    // for everybody, including Max.
    for (const feature of ALL_FEATURES) {
      expect(PLAN_RANK[FEATURE_MIN_PLAN[feature]]).toEqual(expect.any(Number));
    }
  });
});
