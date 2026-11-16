/**
 * `npm run email:preview`: renders every registered template's fixture and
 * variants to `email-previews/`, plus an `index.html` linking them all.
 * Assets load from EMAIL_ASSET_BASE_URL, else the local frontend.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderEmail } from '../render/render-email';
import { ALL_TEMPLATES } from '../templates/registry';
import type { RenderContext } from '../templates/types';
import { PREVIEW_ASSET_BASE } from './preview-assets';

interface PreviewEntry {
  file: string;
  subject: string;
  preheader: string;
}

const OUT_DIR = join(process.cwd(), 'email-previews');

const CTX: RenderContext = {
  assetBaseUrl: PREVIEW_ASSET_BASE,
  footer: {
    reason: 'Preview footer',
    links: [
      { label: 'Help center', href: 'https://schedura.ai/help' },
      { label: 'Privacy', href: 'https://schedura.ai/privacy' },
    ],
  },
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function indexHtml(entries: PreviewEntry[]): string {
  const items = entries
    .map(
      (e) =>
        `<li><a href="${escapeHtml(e.file)}">${escapeHtml(e.file)}</a>` +
        ` <strong>${escapeHtml(e.subject)}</strong>` +
        ` <span>${escapeHtml(e.preheader)}</span></li>`,
    )
    .join('\n');
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Email previews</title></head>
<body style="font-family: system-ui, sans-serif; padding: 24px">
<h1>Email previews (${entries.length})</h1>
<ul>
${items}
</ul>
</body>
</html>
`;
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  const entries: PreviewEntry[] = [];

  for (const def of ALL_TEMPLATES) {
    const cases: Array<[string, unknown]> = [
      [def.id, def.fixture],
      ...Object.entries(def.variants ?? {}).map(
        ([variant, props]): [string, unknown] => [
          `${def.id}--${variant}`,
          props,
        ],
      ),
    ];
    for (const [name, props] of cases) {
      const email = await renderEmail(def, props, CTX);
      const file = `${name}.html`;
      writeFileSync(join(OUT_DIR, file), email.html);
      entries.push({
        file,
        subject: email.subject,
        preheader: email.preheader,
      });
    }
  }

  writeFileSync(join(OUT_DIR, 'index.html'), indexHtml(entries));
  console.log(`Wrote ${entries.length} previews to ${OUT_DIR}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
