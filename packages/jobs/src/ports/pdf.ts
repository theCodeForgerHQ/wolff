import type { PdfRenderer } from '../types';

/**
 * Renders a page to PDF with headless Chromium. On Linux (a container, a
 * Vercel function) the browser comes from @sparticuz/chromium; elsewhere set
 * CHROME_EXECUTABLE_PATH to a local Chrome. A browser is started per render
 * and closed afterwards: renders are rare, and a function instance may be
 * frozen between invocations.
 */
export function createChromiumPdfRenderer(options: { executablePath?: string } = {}): PdfRenderer {
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
        await page.goto(url, { waitUntil: 'networkidle0', timeout: 30_000 });
        return await page.pdf({ format: 'A4', printBackground: true });
      } finally {
        await browser.close();
      }
    },
  };
}
