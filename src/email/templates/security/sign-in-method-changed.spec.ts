import { renderEmail } from '../../render/render-email';
import type { RenderContext } from '../types';
import { SECURITY_TEMPLATES } from './index';
import {
  signInMethodChangedTemplate,
  type SignInMethodChangedProps,
} from './sign-in-method-changed';

const ctx: RenderContext = {
  assetBaseUrl: 'https://app.test/email',
  footer: {
    reason: 'Why line',
    links: [{ label: 'Privacy', href: 'https://s.test/privacy' }],
  },
};

describe('sign-in-method-changed template', () => {
  const props: SignInMethodChangedProps = signInMethodChangedTemplate.fixture;

  it('is registered in the security group', () => {
    expect(SECURITY_TEMPLATES).toContain(signInMethodChangedTemplate);
  });

  it('is mandatory security mail: no event, security footer', () => {
    expect(signInMethodChangedTemplate.id).toBe('sign-in-method-changed');
    expect(signInMethodChangedTemplate.category).toBe('security');
    expect(signInMethodChangedTemplate.event).toBeNull();
    expect(signInMethodChangedTemplate.footer).toBe('security');
  });

  it('subject names what was removed', () => {
    expect(signInMethodChangedTemplate.subject(props)).toBe(
      'Google sign-in was removed from your Schedura account',
    );
  });

  it('names the device, place and time, and carries the "This wasn’t me" link', async () => {
    const r = await renderEmail(signInMethodChangedTemplate, props, ctx);
    expect(r.html).toContain('Chrome on Windows');
    expect(r.html).toContain('Pakistan (approximate)');
    expect(r.html).toContain('Oct 26, 2026 at 10:42 AM GMT+5');
    expect(r.html).toContain(props.resetUrl);
    expect(r.html).toContain('This wasn’t me');
    expect(r.html.match(/data-email-button/g)).toHaveLength(1);
    expect(r.text).toContain(props.resetUrl);
  });

  it('leaves the Location row out when GeoIP found no country', async () => {
    const r = await renderEmail(
      signInMethodChangedTemplate,
      { ...props, location: null },
      ctx,
    );
    expect(r.html).not.toContain('Location');
    expect(r.html).not.toContain('approximate');
  });

  it('escapes a hostile device label', async () => {
    const r = await renderEmail(
      signInMethodChangedTemplate,
      { ...props, device: '<script>x</script> & "q"' },
      ctx,
    );
    expect(r.html).not.toContain('<script>x</script>');
    expect(r.html).toContain('&lt;script&gt;x&lt;/script&gt; &amp;');
  });
});
