import type { PdfRenderer } from '../types';

/**
 * Renders a page to PDF with headless Chromium. On Linux (a container, a
 * Vercel function) the browser comes from @sparticuz/chromium; elsewhere set
 * CHROME_EXECUTABLE_PATH to a local Chrome. A browser is started per render
 * and closed afterwards: renders are rare, and a function instance may be
 * frozen between invocations.
 */
export interface PdfRendererOptions {
  executablePath?: string;
  /**
   * Vercel deployment protection on the web app: requests to `origin` (and
   * only there) carry `x-vercel-protection-bypass: <secret>`, so the page
   * renders instead of Vercel's login page. Third-party requests the page
   * makes (fonts, scripts) never see the secret.
   */
  protectionBypass?: { origin: string; secret: string };
}

const BYPASS_HEADER = 'x-vercel-protection-bypass';

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export function createChromiumPdfRenderer(options: PdfRendererOptions = {}): PdfRenderer {
  const bypass = options.protectionBypass;
  const bypassOrigin = bypass ? originOf(bypass.origin) : null;
  return {
    async render(url) {
      const { default: puppeteer } = await import('puppeteer-core');
      let executablePath = options.executablePath;
      let args: string[] = [];
      if (!executablePath) {
        const { default: chromium } = await import('@sparticuz/chromium');
        executablePath = await chromium.executablePath();
        args = chromium.args;
      }

      const browser = await puppeteer.launch({ executablePath, args, headless: true });
      try {
        const page = await browser.newPage();
        if (bypass && bypassOrigin) {
          // Per request, not setExtraHTTPHeaders: that would send the secret
          // to every host the page loads from.
          await page.setRequestInterception(true);
          page.on('request', (request) => {
            if (request.isInterceptResolutionHandled()) return;
            if (originOf(request.url()) !== bypassOrigin) {
              void request.continue();
              return;
            }
            void request.continue({
              headers: { ...request.headers(), [BYPASS_HEADER]: bypass.secret },
            });
          });
        }
        await page.goto(url, { waitUntil: 'networkidle0', timeout: 30_000 });
        return await page.pdf({ format: 'A4', printBackground: true });
      } finally {
        await browser.close();
      }
    },
  };
}
