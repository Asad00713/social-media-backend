import { confirmPage, donePage, invalidLinkPage } from './email-pages';

const EVIL = '<script>alert(1)</script> & "q"';
const ESCAPED = '&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;q&quot;';

describe('email pages', () => {
  it('escapes every value in the confirm page, including the form action', () => {
    const html = confirmPage({
      title: EVIL,
      body: EVIL,
      action: '/email/unsubscribe/"><script>x</script>',
      button: EVIL,
    });
    expect(html).not.toContain('<script>');
    expect(html).toContain(ESCAPED);
    expect(html).toContain('method="post"');
    expect(html).toContain(
      'action="/email/unsubscribe/&quot;&gt;&lt;script&gt;x&lt;/script&gt;"',
    );
  });

  it('escapes the done page and its link, and omits the link when there is none', () => {
    const withLink = donePage({
      title: EVIL,
      body: EVIL,
      link: { href: 'https://x.test/?a=1&b="2"', label: EVIL },
    });
    expect(withLink).not.toContain('<script>');
    expect(withLink).toContain(ESCAPED);
    expect(withLink).toContain(
      'href="https://x.test/?a=1&amp;b=&quot;2&quot;"',
    );
    expect(donePage({ title: 'T', body: 'B' })).not.toContain('<a ');
  });

  it('carries no script and no form on the done and invalid pages', () => {
    for (const html of [
      donePage({ title: 'T', body: 'B' }),
      invalidLinkPage(),
    ]) {
      expect(html).not.toContain('<form');
      expect(html).not.toContain('<script');
      expect(html).toContain('noindex');
    }
  });
});
