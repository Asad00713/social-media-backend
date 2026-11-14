import { escapeHtml } from '../../insights/reports/lib/escape-html';
import { page } from '../../insights/reports/lib/report-pages';

/**
 * The pages a person sees from the links in an email: plain HTML with inline
 * styles and no script, the same look as the report pages, so they work in any
 * mail client's browser and a strict Content-Security-Policy can forbid
 * everything else. Every value goes through escapeHtml.
 */

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

export function invalidLinkPage(): string {
  const title = "This link doesn't work";
  return page(
    escapeHtml(title),
    `<h1>${escapeHtml(title)}</h1>
<p>It may have been copied incompletely. To change which emails you get, open Notifications in your Schedura settings.</p>`,
  );
}
