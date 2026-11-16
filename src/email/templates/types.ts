import type { ReactElement } from 'react';
import type { DbType } from '../../drizzle/db';
import type { AppLinks } from '../links/app-links';
import type { TemplateId } from './template-ids';

/** The Resend `category` tag (spec §4.2). */
export type EmailCategory =
  | 'security'
  | 'account'
  | 'billing'
  | 'team'
  | 'publishing'
  | 'inbox'
  | 'support'
  | 'lifecycle'
  | 'reports'
  | 'leads';

/** Which footer class the template uses (spec §4.1 table). */
export type FooterKind =
  | 'notification'
  | 'security'
  | 'account'
  | 'billing'
  | 'plain';

export interface FooterLink {
  label: string;
  href: string;
}

/** The resolved footer: line 1 and the links row. Line 3 is fixed. */
export interface FooterContext {
  reason: string;
  links: FooterLink[];
}

/** What a template's `stillApplies` guard may read. */
export interface TemplateGuardDeps {
  db: DbType;
}

export interface EmailTemplateDef<P> {
  id: TemplateId;
  category: EmailCategory;
  /** Preference key that can turn it off; null = mandatory. Typed as string here; T2 narrows it. */
  event: string | null;
  /**
   * For a template that serves several preference events (`inbox-activity`):
   * the event for these props. It wins over `event`, which stays the default.
   */
  eventFor?(p: P): string;
  footer: FooterKind;
  subject(p: P): string;
  preheader(p: P): string;
  /** Overrides footer line 1 (e.g. A1, B1, C3, E1, F1, F2). */
  footerReason?(p: P): string;
  /**
   * Extra links go AFTER "Help center" (E1: Help center · Status · Privacy).
   * A function gets AppLinks, for a link built from env (E1 Status).
   */
  extraFooterLinks?: FooterLink[] | ((links: AppLinks) => FooterLink[]);
  Body(p: P): ReactElement;
  /**
   * Send-time guard for mail that can go stale while its job waits (B3 waits
   * out the removal undo window). The worker checks it after the preference
   * and suppression checks and before rendering: false skips the send, and so
   * does a guard that throws.
   */
  stillApplies?(p: P, deps: TemplateGuardDeps): Promise<boolean>;
  /** Figma placeholder data, used by the preview and the contract spec. */
  fixture: P;
  /** Extra previews (D3 kinds, C2 kinds, A5 via). */
  variants?: Record<string, P>;
}

// any: the registry erases P; enqueue() is typed by the def.
export type AnyTemplateDef = EmailTemplateDef<any>;

export interface RenderContext {
  assetBaseUrl: string;
  footer: FooterContext;
}
