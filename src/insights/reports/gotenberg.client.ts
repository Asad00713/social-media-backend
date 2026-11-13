import { ServiceUnavailableException } from '@nestjs/common';

/** Gotenberg is not set up on this server (GOTENBERG_URL is unset). */
export class GotenbergNotConfiguredError extends ServiceUnavailableException {
  constructor() {
    super("PDF export isn't set up on this server.");
  }
}

/** Gotenberg answered with an error status, or did not answer in time. */
export class GotenbergError extends Error {
  constructor(
    message: string,
    /** `timeout` when the call was aborted, `failed` for anything else. */
    readonly kind: 'timeout' | 'failed' = 'failed',
  ) {
    super(message);
    this.name = 'GotenbergError';
  }
}

/** A4 in inches, which is what Gotenberg reads a bare number as. */
const A4_WIDTH = '8.27';
const A4_HEIGHT = '11.7';

/**
 * The page sets `window.__reportReady` once its numbers have drawn, so the PDF
 * is never a loading screen.
 */
const READY_EXPRESSION = 'window.__reportReady === true';

/**
 * Prints a web page to PDF with Gotenberg 8 (Chromium). The report page is a
 * fixed 794 px column with its own padding, so every paper margin is 0.
 */
export class GotenbergClient {
  private readonly baseUrl: string | null;

  constructor(
    baseUrl: string | undefined,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 30_000,
  ) {
    this.baseUrl = baseUrl?.trim() ? baseUrl.trim().replace(/\/+$/, '') : null;
  }

  isConfigured(): boolean {
    return this.baseUrl !== null;
  }

  async pdfFromUrl(url: string): Promise<Buffer> {
    if (!this.baseUrl) throw new GotenbergNotConfiguredError();

    const form = new FormData();
    form.set('url', url);
    form.set('waitForExpression', READY_EXPRESSION);
    form.set('paperWidth', A4_WIDTH);
    form.set('paperHeight', A4_HEIGHT);
    for (const side of ['Top', 'Bottom', 'Left', 'Right']) {
      form.set(`margin${side}`, '0');
    }
    form.set('printBackground', 'true');

    // The body is read inside the same try: a stall or reset while the PDF
    // streams in is the same kind of failure as one before the headers.
    try {
      const res = await this.fetchImpl(
        `${this.baseUrl}/forms/chromium/convert/url`,
        {
          method: 'POST',
          body: form,
          signal: AbortSignal.timeout(this.timeoutMs),
        },
      );
      if (!res.ok) throw new GotenbergError(`answered ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (e) {
      if (e instanceof GotenbergError) throw e;
      const name = (e as { name?: string }).name;
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new GotenbergError(
          `timed out after ${this.timeoutMs / 1000}s`,
          'timeout',
        );
      }
      throw new GotenbergError(
        `could not be reached: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}
