import {
  confirmUnsubscribePage,
  invalidUnsubscribePage,
  unsubscribedPage,
} from './report-pages';

describe('report pages', () => {
  const NAME = '<b>x</b>';

  it('escapes the report name on the confirm page and the done page', () => {
    const confirm = confirmUnsubscribePage(NAME, '/reports/unsubscribe/t');
    const done = unsubscribedPage(NAME);
    for (const html of [confirm, done]) {
      expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
      expect(html).not.toContain('<b>x</b>');
    }
  });

  it('asks before changing anything: one POST form, one button, no script', () => {
    const html = confirmUnsubscribePage(
      'Acme',
      '/reports/unsubscribe/abc.d-e_f',
    );
    expect(html.match(/<form method="post"/g)).toHaveLength(1);
    expect(html).toContain('action="/reports/unsubscribe/abc.d-e_f"');
    expect(html).toContain('<title>Stop receiving Acme?</title>');
    expect(html).toContain('<h1');
    expect(html).toContain('Stop receiving Acme?');
    expect(html).toContain('<button type="submit"');
    expect(html).toContain('Stop receiving it');
    expect(html).not.toContain('<script');
  });

  it('escapes the form action', () => {
    const html = confirmUnsubscribePage('Acme', '/x"><script>1</script>');
    expect(html).not.toContain('<script');
    expect(html).toContain('&quot;&gt;&lt;script&gt;');
  });

  it('confirms the opt-out in the done page', () => {
    const html = unsubscribedPage("Acme's report");
    expect(html).toContain("You won't get Acme&#39;s report again.");
    expect(html).not.toContain('<form');
  });

  it('tells a stale link what to do next', () => {
    const html = invalidUnsubscribePage();
    expect(html).toContain("<title>This link doesn't work</title>");
    expect(html).toContain(
      'Ask the person who sent you the report to take you off the list.',
    );
  });
});
