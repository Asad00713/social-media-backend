import type { Response } from 'express';
import { escapeHtml } from '../../insights/reports/lib/escape-html';
import { page } from '../../insights/reports/lib/report-pages';

/**
 * The pages a person sees from the links in an email: plain HTML with inline
 * styles and no script, the same look as the report pages, so they work in any
 * mail client's browser and a strict Content-Security-Policy can forbid
 * everything else. Every value goes through escapeHtml.
 */

/** The pages carry no script and load nothing; nothing may frame the button. */
const PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'";

/**
 * The first line of every handler that answers with one of these pages, so
 * even a 500 carries them. The token in the path is the credential: the answer
 * is private to the caller, never cached or indexed, and the URL never leaves
 * in a Referer.
 */
export function setPageHeaders(res: Response): void {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Robots-Tag', 'noindex');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', PAGE_CSP);
}

export function sendPage(res: Response, status: number, html: string): void {
  res.status(status).type('text/html; charset=utf-8').send(html);
}

/**
 * Step one of two: the GET only asks. A mail client's link scanner opens every
 * link in a message, so a GET that changed anything would act for people who
 * never clicked. `action` is the path the button posts to.
 */
export function confirmPage(o: {
  title: string;
  body: string;
  action: string;
  button: string;
}): string {
  const title = escapeHtml(o.title);
  return page(
    title,
    `<h1>${title}</h1>
<p>${escapeHtml(o.body)}</p>
<form method="post" action="${escapeHtml(o.action)}">
<button type="submit">${escapeHtml(o.button)}</button>
</form>`,
  );
}

export function donePage(o: {
  title: string;
  body: string;
  link?: { href: string; label: string };
}): string {
  const title = escapeHtml(o.title);
  const link = o.link
    ? `\n<p><a href="${escapeHtml(o.link.href)}">${escapeHtml(o.link.label)}</a></p>`
    : '';
  return page(
    title,
    `<h1>${title}</h1>
<p>${escapeHtml(o.body)}</p>${link}`,
  );
}

/** `hint` replaces the unsubscribe advice, for links that are not about notifications. */
export function invalidLinkPage(
  hint = 'It may have been copied incompletely. To change which emails you get, open Notifications in your Schedura settings.',
): string {
  const title = "This link doesn't work";
  return page(
    escapeHtml(title),
    `<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(hint)}</p>`,
  );
}
