export type PdfDocumentKind = 'quote' | 'invoice';

/** Server-side PDF endpoint (Puppeteer-rendered) for a saved document. */
export function getPdfDownloadUrl(kind: PdfDocumentKind, id: string): string {
  return `/api/download/${kind}/${encodeURIComponent(id)}`;
}

/** Fetches the server-rendered PDF and triggers a browser download. Throws on failure. */
export async function downloadServerPdf(
  kind: PdfDocumentKind,
  id: string,
  fallbackFilename: string
): Promise<void> {
  const response = await fetch(getPdfDownloadUrl(kind, id), { credentials: 'same-origin' });
  if (!response.ok) {
    throw new Error(`PDF download failed (${response.status})`);
  }
  const blob = await response.blob();
  const match = /filename="([^"]+)"/.exec(response.headers.get('Content-Disposition') ?? '');
  const filename = match?.[1] ?? fallbackFilename;

  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(objectUrl);
}
