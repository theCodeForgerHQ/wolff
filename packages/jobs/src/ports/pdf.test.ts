import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createChromiumPdfRenderer } from './pdf';

/**
 * Renders with a real Chrome (set CHROME_EXECUTABLE_PATH) against two local
 * servers on different origins: the app page, and a third party it loads an
 * image from. The protection-bypass secret must reach the first only.
 */
const chrome = process.env.CHROME_EXECUTABLE_PATH;
const SECRET = 'bypass-secret-for-test';

function listen(handler: (headers: IncomingHttpHeaders, url: string) => string) {
  return new Promise<{ server: Server; origin: string }>((resolve) => {
    const server = createServer((req, res) => {
      const body = handler(req.headers, req.url ?? '/');
      res.writeHead(200, { 'content-type': body.startsWith('<') ? 'text/html' : 'image/svg+xml' });
      res.end(body);
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, origin: `http://127.0.0.1:${port}` });
    });
  });
}

describe.skipIf(!chrome)('createChromiumPdfRenderer (real Chrome)', () => {
  const seen = { app: [] as IncomingHttpHeaders[], third: [] as IncomingHttpHeaders[] };
  let app: { server: Server; origin: string };
  let third: { server: Server; origin: string };

  beforeAll(async () => {
    third = await listen((headers) => {
      seen.third.push(headers);
      return '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>';
    });
    app = await listen((headers, url) => {
      seen.app.push(headers);
      return url.startsWith('/logo')
        ? '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'
        : `<html><body><h1>INV-0042</h1><img src="/logo.svg"><img src="${third.origin}/x.svg"></body></html>`;
    });
  });

  afterAll(() => {
    app.server.close();
    third.server.close();
  });

  it('sends the bypass header to the app origin and nowhere else', async () => {
    const renderer = createChromiumPdfRenderer({
      executablePath: chrome,
      protectionBypass: { origin: app.origin, secret: SECRET },
    });

    const pdf = await renderer.render(`${app.origin}/i/token`);

    expect(Buffer.from(pdf).subarray(0, 4).toString()).toBe('%PDF');
    expect(seen.app.length).toBeGreaterThanOrEqual(2);
    for (const headers of seen.app) {
      expect(headers['x-vercel-protection-bypass']).toBe(SECRET);
    }
    expect(seen.third.length).toBeGreaterThanOrEqual(1);
    for (const headers of seen.third) {
      expect(headers['x-vercel-protection-bypass']).toBeUndefined();
    }
  }, 60_000);
});

describe.skipIf(!chrome)('createChromiumPdfRenderer error pages (real Chrome)', () => {
  // The page an error answers with (a 404, or the hosting provider's login
  // page) must not be stored as the document's PDF.
  it.each([404, 401, 500])(
    'refuses a page that answered %i',
    async (status) => {
      const server = createServer((_req, res) => {
        res.writeHead(status, { 'content-type': 'text/html' });
        res.end('<html><body>Not the invoice</body></html>');
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address() as AddressInfo;
      try {
        const renderer = createChromiumPdfRenderer({ executablePath: chrome });
        await expect(renderer.render(`http://127.0.0.1:${port}/i/token`)).rejects.toMatchObject({
          name: 'PdfPageError',
          status,
        });
      } finally {
        server.close();
      }
    },
    60_000
  );
});
