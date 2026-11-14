import { renderEmail } from '../render/render-email';
import { ALL_TEMPLATES, getTemplate } from './registry';
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
});
