import { createElement, Fragment } from 'react';
import { defineTemplate } from '../templates/define-template';
import type { RenderContext } from '../templates/types';
import { EmailButton } from './components/button';
import { Callout } from './components/callout';
import { CodeBox } from './components/code-box';
import { DetailRows } from './components/detail-rows';
import { FallbackLink } from './components/fallback-link';
import { People } from './components/people';
import { PostCard } from './components/post-card';
import { PostRow } from './components/post-row';
import { Quote } from './components/quote';
import { Steps } from './components/steps';
import { Heading, Paragraph } from './components/text';
import { renderEmail } from './render-email';

// A local, test-only def: the registry is not involved.
const def = defineTemplate<{ name: string; caption: string }>({
  id: 'welcome',
  category: 'lifecycle',
  event: null,
  footer: 'plain',
  subject: (p) => `Hi ${p.name}\r\nBcc: x@y.z`,
  preheader: () => 'Three things to do first.',
  Body: (p) =>
    createElement(
      Fragment,
      null,
      createElement(Heading, null, 'Hello ', p.name),
      createElement(PostCard, {
        platform: 'instagram',
        handle: '@a',
        when: 'Today',
        caption: p.caption,
      }),
    ),
  fixture: { name: 'R', caption: 'x' },
});

const ctx: RenderContext = {
  assetBaseUrl: 'https://app.test/email',
  footer: {
    reason: 'Why line',
    links: [{ label: 'Privacy', href: 'https://s.test/privacy' }],
  },
};

describe('renderEmail', () => {
  it('strips CR/LF from the subject', async () => {
    const r = await renderEmail(def, def.fixture, ctx);
    expect(r.subject).toBe('Hi R Bcc: x@y.z');
  });

  it('escapes user text in html and keeps a text part', async () => {
    const r = await renderEmail(
      def,
      {
        name: '<script>alert(1)</script>',
        caption: '<img src=x onerror=alert(1)>',
      },
      ctx,
    );
    expect(r.html).not.toContain('<script>alert(1)');
    expect(r.html).toContain('&lt;img src=x');
    // Plain text is not HTML, so the raw characters come back.
    expect(r.text).toContain('Hello <script>alert(1)</script>');
    expect(r.text).not.toMatch(/<(table|td|div|a )/);
  });

  it('puts the preheader and footer in the html', async () => {
    const r = await renderEmail(def, def.fixture, ctx);
    expect(r.preheader).toBe('Three things to do first.');
    expect(r.html).toContain('Three things to do first.');
    expect(r.html).toContain('Why line');
    expect(r.html).toContain('Schedura · schedura.ai');
    expect(r.html).toContain('https://app.test/email/logo.png');
  });

  it('escapes &, " and \' in user text', async () => {
    const r = await renderEmail(
      def,
      { name: `Tom & "Jerry" O'Neil`, caption: `Fish & 'chips' "today"` },
      ctx,
    );
    expect(r.html).toContain('Tom &amp; &quot;Jerry&quot; O&#x27;Neil');
    expect(r.html).toContain('Fish &amp; &#x27;chips&#x27; &quot;today&quot;');
    expect(r.text).toContain(`Hello Tom & "Jerry" O'Neil`);
  });

  it('puts the footer lines in the text part', async () => {
    const r = await renderEmail(def, def.fixture, ctx);
    expect(r.text).toContain('Why line');
    expect(r.text).toContain('Privacy');
    expect(r.text).toContain('Schedura · schedura.ai');
  });

  it.each(['', '/email', 'email', 'ftp://cdn.test/email'])(
    'refuses a non-http(s) assetBaseUrl %j',
    async (assetBaseUrl) => {
      await expect(
        renderEmail(def, def.fixture, { ...ctx, assetBaseUrl }),
      ).rejects.toThrow('Email assetBaseUrl must be an absolute http(s) URL');
    },
  );
});

describe('renderEmail layout for Outlook', () => {
  // Every block in one body, so the table checks cover all of them.
  const allBlocks = defineTemplate<Record<string, never>>({
    id: 'welcome',
    category: 'lifecycle',
    event: null,
    footer: 'plain',
    subject: () => 'All blocks',
    preheader: () => 'Every block once.',
    Body: () =>
      createElement(
        Fragment,
        null,
        createElement(People, {
          from: { initials: 'MR', name: 'M Rehman' },
          to: { initials: 'RW', name: 'Rehman Workspace' },
        }),
        createElement(Heading, null, 'Heading'),
        createElement(Paragraph, { tone: 'muted', children: 'Muted note' }),
        createElement(CodeBox, { code: '482913' }),
        createElement(Callout, { tone: 'danger', children: 'Danger' }),
        createElement(PostCard, {
          platform: 'instagram',
          handle: '@a',
          when: 'Today',
          caption: 'x',
          thumbnailUrl: 'https://cdn.test/t.jpg',
        }),
        createElement(PostRow, {
          platform: 'tiktok',
          handle: '@a',
          when: '8:00 AM',
          title: 'Title',
          reason: 'Reason',
          thumbnailUrl: 'https://cdn.test/t.jpg',
        }),
        createElement(Quote, { meta: 'Meta', children: 'Words' }),
        createElement(DetailRows, {
          title: 'Title',
          rows: [{ label: 'Plan', value: 'Pro' }],
        }),
        createElement(Steps, { steps: [{ title: 'One', body: 'First' }] }),
        createElement(EmailButton, {
          href: 'https://app.test/x',
          variant: 'primary',
          children: 'Go',
        }),
        createElement(FallbackLink, { href: 'https://app.test/x' }),
      ),
    fixture: {},
  });

  it('never puts padding on a <table> (Outlook ignores it)', async () => {
    const { html } = await renderEmail(allBlocks, {}, ctx);
    const tables = html.match(/<table\b[^>]*>/g) ?? [];
    expect(tables.length).toBeGreaterThan(10);
    const padded = tables.filter((t) => /style="[^"]*padding/.test(t));
    expect(padded).toEqual([]);
  });

  it('gives the shell a fixed 600 px width', async () => {
    const { html } = await renderEmail(allBlocks, {}, ctx);
    const shell = html.match(/<table\b[^>]*class="email-shell"[^>]*>/)?.[0];
    expect(shell).toBeDefined();
    expect(shell).toContain('width="600"');
    expect(shell).toMatch(/style="[^"]*width:600px/);
    expect(html).toContain('.email-shell { width: 100% !important; }');
  });
});
