import { render } from '@react-email/components';
import { createElement, type ReactElement } from 'react';
import { EmailContext } from '../email-context';
import { EmailButton } from './button';
import { Callout } from './callout';
import { CodeBox } from './code-box';
import { PostCard } from './post-card';
import { PostRow } from './post-row';

const ASSETS = 'https://app.test/email';

function renderBlock(el: ReactElement): Promise<string> {
  return render(
    createElement(
      EmailContext.Provider,
      { value: { assetBaseUrl: ASSETS } },
      el,
    ),
  );
}

function card(caption: string, platform = 'instagram'): ReactElement {
  return createElement(PostCard, {
    platform,
    handle: '@lumierecafe',
    when: 'Today, 6:30 PM',
    caption,
  });
}

describe('email blocks', () => {
  it('CodeBox groups six digits 3+3', async () => {
    const html = await renderBlock(createElement(CodeBox, { code: '482913' }));
    expect(html).toContain('482 913');
  });

  it('PostCard truncates captions over 280 chars and shows (No caption) for blank', async () => {
    const long = await renderBlock(card('a'.repeat(5000)));
    expect(long).toContain(`${'a'.repeat(279)}…`);
    expect(long).not.toContain('a'.repeat(280));

    const exact = await renderBlock(card('b'.repeat(280)));
    expect(exact).toContain('b'.repeat(280));
    expect(exact).not.toContain('…');

    const blank = await renderBlock(card('   \n  '));
    expect(blank).toContain('(No caption)');
  });

  it('PostCard does not split an emoji when it truncates', async () => {
    const html = await renderBlock(card(`${'c'.repeat(278)}☕☕☕`));
    expect(html).toContain(`${'c'.repeat(278)}☕…`);
  });

  it('PostCard uses network-generic.png for an unknown platform', async () => {
    const known = await renderBlock(card('x'));
    expect(known).toContain(`${ASSETS}/network-instagram.png`);
    const unknown = await renderBlock(card('x', 'myspace'));
    expect(unknown).toContain(`${ASSETS}/network-generic.png`);
    expect(unknown).not.toContain('network-myspace');
  });

  it('PostCard keeps the icon and handle on one line and lets a long time wrap', async () => {
    const html = await renderBlock(
      createElement(PostCard, {
        platform: 'instagram',
        handle: '@lumierecafe',
        when: 'Oct 26, 2026 at 6:30 PM GMT+5',
        caption: 'x',
      }),
    );
    const handle = html.match(/<td\b[^>]*data-post-card-handle[^>]*>/)?.[0];
    const when = html.match(/<td\b[^>]*data-post-card-when[^>]*>/)?.[0];
    expect(handle).toMatch(/white-space:nowrap/);
    expect(when).toBeDefined();
    expect(when).not.toMatch(/white-space:nowrap/);
  });

  it('PostCard shows the thumbnail only when there is one', async () => {
    const withThumb = await renderBlock(
      createElement(PostCard, {
        platform: 'instagram',
        handle: '@a',
        when: 'Today',
        caption: 'x',
        thumbnailUrl: 'https://cdn.test/t.jpg',
      }),
    );
    expect(withThumb).toContain('https://cdn.test/t.jpg');
    const without = await renderBlock(card('x'));
    expect(without).not.toContain('cdn.test');
  });

  it('PostRow applies the caption rule to its title and shows the reason', async () => {
    const html = await renderBlock(
      createElement(PostRow, {
        platform: 'linkedin',
        handle: 'Lumière Café',
        when: '12:15 PM',
        title: '',
        reason: 'Image is larger than LinkedIn allows',
      }),
    );
    expect(html).toContain('(No caption)');
    expect(html).toContain('Image is larger than LinkedIn allows');
    expect(html).toContain(`${ASSETS}/network-linkedin.png`);
  });

  it('Callout uses the icon for its tone', async () => {
    const html = await renderBlock(
      createElement(Callout, { tone: 'warning', children: 'Heads up' }),
    );
    expect(html).toContain(`${ASSETS}/icon-warning.png`);
    expect(html).toContain('Heads up');
  });

  it('Callout tints warning #FEF3E2 and danger #FDECEC, as in Figma', async () => {
    const warning = await renderBlock(
      createElement(Callout, { tone: 'warning', children: 'W' }),
    );
    const danger = await renderBlock(
      createElement(Callout, { tone: 'danger', children: 'D' }),
    );
    expect(warning).toMatch(/background-color:#FEF3E2/i);
    expect(danger).toMatch(/background-color:#FDECEC/i);
  });

  it('EmailButton secondary has a border and no primary background', async () => {
    const secondary = await renderBlock(
      createElement(EmailButton, {
        href: 'https://app.test/x',
        variant: 'secondary',
        children: 'Open Schedura',
      }),
    );
    expect(secondary).toMatch(/border:1px solid #E5E7EB/i);
    expect(secondary).not.toMatch(/background-color:#2563EB/i);
    expect(secondary).toContain('data-email-button');

    const primary = await renderBlock(
      createElement(EmailButton, {
        href: 'https://app.test/x',
        variant: 'primary',
        children: 'Open Schedura',
      }),
    );
    expect(primary).toMatch(/background-color:#2563EB/i);
  });
});
