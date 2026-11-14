import { render } from '@react-email/components';
import type { EmailTemplateDef, RenderContext } from '../templates/types';
import { EmailLayout } from './components/layout';
import { EmailContext } from './email-context';

export interface RenderedEmail {
  subject: string;
  preheader: string;
  html: string;
  text: string;
}

/**
 * Plain-text conversion: headings stay as written (html-to-text uppercases
 * them), and layout cells end with a space so `Channels` and `8 connected`
 * don't run together.
 */
const TEXT_SELECTORS = [
  ...['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].map((selector) => ({
    selector,
    options: { uppercase: false },
  })),
  { selector: 'td', format: 'inlineSurround', options: { suffix: ' ' } },
];

/** Trims each line and keeps at most one blank line between blocks. */
function tidyText(text: string): string {
  return text
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** A subject is one header line: CR/LF would let text inject headers. */
function toSubjectLine(subject: string): string {
  return subject.replace(/\s*[\r\n]+\s*/g, ' ').trim();
}

/** Renders a template into the subject, preheader, HTML and plain-text parts. */
export async function renderEmail<P>(
  def: EmailTemplateDef<P>,
  props: P,
  ctx: RenderContext,
): Promise<RenderedEmail> {
  const preheader = def.preheader(props);
  const email = (
    <EmailContext.Provider value={{ assetBaseUrl: ctx.assetBaseUrl }}>
      <EmailLayout preheader={preheader} footer={ctx.footer}>
        {def.Body(props)}
      </EmailLayout>
    </EmailContext.Provider>
  );
  const [html, text] = await Promise.all([
    render(email),
    render(email, {
      plainText: true,
      htmlToTextOptions: { selectors: TEXT_SELECTORS },
    }),
  ]);
  return {
    subject: toSubjectLine(def.subject(props)),
    preheader,
    html,
    text: tidyText(text),
  };
}
