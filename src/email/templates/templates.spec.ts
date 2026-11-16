import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NOTIFICATION_EVENTS } from '../../notification-preferences/notification-events';
import { renderEmail } from '../render/render-email';
import { ALL_TEMPLATES, getTemplate } from './registry';
import { eventOf } from './define-template';
import { TEMPLATE_IDS } from './template-ids';
import type { AnyTemplateDef, RenderContext } from './types';

const ctx: RenderContext = {
  assetBaseUrl: 'https://app.test/email',
  footer: {
    reason: 'Why line',
    links: [{ label: 'Privacy', href: 'https://s.test/privacy' }],
  },
};

type Case = [name: string, def: AnyTemplateDef, props: unknown];

// Every registered template, plus each of its variants.
const CASES: Case[] = ALL_TEMPLATES.flatMap((d): Case[] => [
  [d.id, d, d.fixture],
  ...Object.entries(d.variants ?? {}).map(
    ([k, v]): Case => [`${d.id}--${k}`, d, v],
  ),
]);

/** The preheader as React writes it into a text node. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

// describe.each throws on an empty table, and the registry is empty until
// the template tasks land, so the contract only runs when there are cases.
const describeEachTemplate = CASES.length > 0 ? describe.each(CASES) : null;

describeEachTemplate?.('%s', (_name, def, props) => {
  it('renders subject, preheader, html and a text part', async () => {
    const r = await renderEmail(def, props, ctx);
    expect(r.subject.length).toBeGreaterThan(0);
    expect(r.subject).not.toMatch(/[\r\n]/);
    expect(r.html).toContain(escapeHtml(def.preheader(props)));
    expect(r.text.length).toBeGreaterThan(20);
  });

  it('has exactly one or zero buttons', async () => {
    const r = await renderEmail(def, props, ctx);
    const buttons = r.html.match(/data-email-button/g) ?? [];
    expect(buttons.length).toBeLessThanOrEqual(1);
  });
});

describe('thumbnail previews', () => {
  it.each(['post-failed', 'posts-failed', 'approval-needed', 'post-approved'])(
    '%s has a --thumbnail preview that shows preview-thumbnail.png',
    async (id) => {
      const def = getTemplate(id);
      const props = def.variants?.thumbnail;
      expect(props).toBeDefined();
      const r = await renderEmail(def, props, ctx);
      expect(r.html).toMatch(/<img[^>]+src="[^"]*\/preview-thumbnail\.png"/);
      // The fixture itself stays as it was: no thumbnail.
      const plain = await renderEmail(def, def.fixture, ctx);
      expect(plain.html).not.toContain('preview-thumbnail.png');
    },
  );
});

describe('template registry', () => {
  it('template ids are unique and known', () => {
    const ids = ALL_TEMPLATES.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    ids.forEach((id) => expect(TEMPLATE_IDS).toContain(id));
  });

  it('getTemplate throws for an unknown id', () => {
    expect(() => getTemplate('nope')).toThrow('Unknown email template "nope"');
  });

  it('TEMPLATE_IDS lists the 29 ids from the spec, once each', () => {
    expect(TEMPLATE_IDS).toHaveLength(29);
    expect(new Set(TEMPLATE_IDS).size).toBe(29);
  });

  it('every TEMPLATE_ID is registered', () => {
    expect(ALL_TEMPLATES.map((d) => d.id).sort()).toEqual(
      [...TEMPLATE_IDS].sort(),
    );
  });

  it('every notification-footer template has an event, and every event-less template a non-notification footer', () => {
    // The two halves are one rule: a notification footer carries the
    // unsubscribe link for an event, so an event-less (mandatory) template
    // can never use it.
    const broken = ALL_TEMPLATES.filter(
      (d) => d.footer === 'notification' && d.event === null,
    ).map((d) => d.id);
    expect(broken).toEqual([]);
  });

  it('every event a template names is a key of NOTIFICATION_EVENTS', () => {
    for (const d of ALL_TEMPLATES) {
      const events = [
        d.event,
        ...CASES.filter(([, c]) => c === d).map(([, c, props]) =>
          eventOf(c, props),
        ),
      ];
      for (const e of events) {
        if (e !== null) expect(Object.keys(NOTIFICATION_EVENTS)).toContain(e);
      }
    }
  });
});

describe('email source text', () => {
  /** Every non-spec .ts/.tsx under src/email, read as text. */
  function sourceFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = join(dir, e.name);
      if (e.isDirectory()) return sourceFiles(full);
      return /\.tsx?$/.test(e.name) && !/\.spec\.tsx?$/.test(e.name)
        ? [full]
        : [];
    });
  }

  it('no template or EmailService string contains a placeholder domain or the old product name', () => {
    const files = sourceFiles(join(__dirname, '..'));
    expect(files.length).toBeGreaterThan(40);
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      expect({ file, hit: /yourdomain/i.test(text) }).toEqual({
        file,
        hit: false,
      });
      expect({ file, hit: /Social Media Automation/i.test(text) }).toEqual({
        file,
        hit: false,
      });
    }
  });
});
