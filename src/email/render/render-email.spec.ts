import { createElement, Fragment } from 'react';
import { defineTemplate } from '../templates/define-template';
import type { RenderContext } from '../templates/types';
import { Heading } from './components/text';
import { PostCard } from './components/post-card';
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

  it('puts the footer lines in the text part', async () => {
    const r = await renderEmail(def, def.fixture, ctx);
    expect(r.text).toContain('Why line');
    expect(r.text).toContain('Privacy');
    expect(r.text).toContain('Schedura · schedura.ai');
  });
});
