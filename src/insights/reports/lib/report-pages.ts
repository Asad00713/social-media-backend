import { escapeHtml } from './escape-html';

/**
 * The pages a person sees from the unsubscribe link in a report email. Plain
 * HTML with inline styles and no script, so they work in any mail client's
 * browser and a strict Content-Security-Policy can forbid everything else.
 * Every interpolation goes through escapeHtml.
 */

const STYLE = `body{margin:0;padding:48px 16px;background:#f6f7f9;color:#1c1f26;font:16px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif}main{max-width:440px;margin:0 auto;padding:32px;background:#fff;border:1px solid #e3e6eb;border-radius:12px}h1{margin:0 0 12px;font-size:20px;line-height:1.3}p{margin:0 0 20px;color:#4a505c}button{padding:10px 18px;border:0;border-radius:8px;background:#1c1f26;color:#fff;font:inherit;font-weight:600;cursor:pointer}`;

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>`;
}

/**
 * Step one of two: the GET only asks. A mail client's link scanner opens every
 * link in a message, so a GET that changed anything would unsubscribe people
 * who never clicked. `actionPath` is the request's own path.
 */
export function confirmUnsubscribePage(
  reportName: string,
  actionPath: string,
): string {
  const heading = `Stop receiving ${escapeHtml(reportName)}?`;
  return page(
    heading,
    `<h1>${heading}</h1>
<p>You will not get this report by email again.</p>
<form method="post" action="${escapeHtml(actionPath)}">
<button type="submit">Stop receiving it</button>
</form>`,
  );
}

export function unsubscribedPage(reportName: string): string {
  const heading = `You won't get ${escapeHtml(reportName)} again.`;
  return page(
    heading,
    `<h1>${heading}</h1>
<p>You can close this page.</p>`,
  );
}

export function invalidUnsubscribePage(): string {
  const heading = "This link doesn't work";
  return page(
    heading,
    `<h1>${heading}</h1>
<p>Ask the person who sent you the report to take you off the list.</p>`,
  );
}
