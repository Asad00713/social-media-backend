import type { ConfigService } from '@nestjs/config';
import { UnrecoverableError } from 'bullmq';
import { createElement, Fragment } from 'react';
import type { DbType } from '../../drizzle/db';
import { AppLinks } from '../links/app-links';
import { defineTemplate } from '../templates/define-template';
import type { AnyTemplateDef, FooterKind } from '../templates/types';
import type { EmailRecipient } from './email-job';
import { EmailFooterService } from './email-footer.service';

const FE = 'http://localhost:3001';
const HELP = { label: 'Help center', href: 'https://schedura.ai/help' };
const PRIVACY = { label: 'Privacy', href: 'https://schedura.ai/privacy' };
const TO: EmailRecipient = { email: 'r@acme.com', userId: 'u1' };

function def(
  footer: FooterKind,
  extra: Partial<AnyTemplateDef> = {},
): AnyTemplateDef {
  return defineTemplate<{ name: string }>({
    id: 'post-failed',
    category: 'publishing',
    event: footer === 'notification' ? 'post_failed' : null,
    footer,
    subject: () => 'S',
    preheader: () => 'P',
    Body: () => createElement(Fragment),
    fixture: { name: 'R' },
    ...extra,
  });
}

/** The one `select name from workspace where id` chain the service runs. */
function make(rows: { name: string }[] = [{ name: 'Rehman Workspace' }]) {
  const where = jest.fn(() => ({ limit: () => Promise.resolve(rows) }));
  const db = { select: () => ({ from: () => ({ where }) }) };
  const links = new AppLinks({
    get: (_key: string, d?: string) => d,
  } as unknown as ConfigService);
  return {
    footer: new EmailFooterService(links, db as unknown as DbType),
    where,
  };
}

describe('EmailFooterService', () => {
  it('footer: notification kind names the event label and workspace and links Manage notifications', async () => {
    const { footer } = make();
    const f = await footer.build(def('notification'), {}, TO, 'ws1');
    expect(f.reason).toBe(
      'You get this because Post failed → Email is on for Rehman Workspace.',
    );
    expect(f.links[0]).toEqual({
      label: 'Manage notifications',
      href: 'http://localhost:3001/w/ws1/settings/notifications',
    });
    expect(f.links).toEqual([
      {
        label: 'Manage notifications',
        href: `${FE}/w/ws1/settings/notifications`,
      },
      HELP,
      PRIVACY,
    ]);
  });

  it('footer: billing kind links Billing help · Privacy', async () => {
    const { footer, where } = make();
    const f = await footer.build(def('billing'), {}, TO, 'ws1');
    expect(f).toEqual({
      reason: "Billing emails go to workspace owners and can't be turned off.",
      links: [
        { label: 'Billing help', href: 'https://schedura.ai/help/billing' },
        PRIVACY,
      ],
    });
    expect(where).not.toHaveBeenCalled();
  });

  it('security and account kinds say they cannot be turned off', async () => {
    const { footer } = make();
    expect(await footer.build(def('security'), {}, TO, null)).toEqual({
      reason: "Security emails can't be turned off.",
      links: [HELP, PRIVACY],
    });
    expect(await footer.build(def('account'), {}, TO, null)).toEqual({
      reason: "Account emails can't be turned off.",
      links: [HELP, PRIVACY],
    });
  });

  it("plain kind uses the template's own sentence", async () => {
    const { footer } = make();
    const plain = def('plain', {
      footerReason: (p: { name: string }) => `Because ${p.name} wrote in.`,
    });
    expect(await footer.build(plain, { name: 'Sam' }, TO, null)).toEqual({
      reason: 'Because Sam wrote in.',
      links: [HELP, PRIVACY],
    });
  });

  it('footerReason overrides line 1 for every kind, without a workspace lookup', async () => {
    const { footer, where } = make();
    const reason = () => 'Custom line.';
    for (const kind of ['notification', 'security', 'billing'] as const) {
      const f = await footer.build(
        def(kind, { footerReason: reason }),
        {},
        TO,
        'ws1',
      );
      expect(f.reason).toBe('Custom line.');
    }
    expect(where).not.toHaveBeenCalled();
  });

  it('puts extra links after Help center', async () => {
    const { footer } = make();
    const status = { label: 'Status', href: 'https://schedura.ai/status' };
    const contact = def('plain', {
      footerReason: () => 'You wrote to us.',
      extraFooterLinks: [status],
    });
    const f = await footer.build(contact, {}, TO, null);
    expect(f.links).toEqual([HELP, status, PRIVACY]);
  });

  it('refuses a notification footer with no workspace or event', async () => {
    const { footer } = make();
    await expect(
      footer.build(def('notification'), {}, TO, null),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    await expect(
      footer.build(def('notification', { event: null }), {}, TO, 'ws1'),
    ).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it('refuses a notification footer for a workspace that no longer exists', async () => {
    const { footer } = make([]);
    await expect(
      footer.build(def('notification'), {}, TO, 'ws1'),
    ).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it('refuses a plain footer without footerReason', async () => {
    const { footer } = make();
    await expect(
      footer.build(def('plain'), {}, TO, null),
    ).rejects.toBeInstanceOf(UnrecoverableError);
  });
});
