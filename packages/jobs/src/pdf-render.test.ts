import { describe, expect, it, vi } from 'vitest';
import { PdfPageError } from './ports/pdf';
import { processors } from './processors';
import { InvalidJobError } from './run';
import type { JobContext } from './types';

function context(renderError: Error) {
  const put = vi.fn();
  const ctx = {
    appUrl: 'https://app.example.test',
    db: {
      invoice: {
        findFirst: vi
          .fn()
          .mockResolvedValue({ accessToken: 't', updatedAt: new Date(0), pdfUrl: null }),
      },
    },
    pdf: { render: vi.fn().mockRejectedValue(renderError) },
    storage: { put },
  } as unknown as JobContext;
  return { ctx, put };
}

const job = { documentType: 'invoice' as const, documentId: 'inv-1', workspaceId: 'ws-1' };

describe('pdf.render when the page is an error', () => {
  it('fails for good on a 4xx: rendering again shows the same page', async () => {
    const { ctx, put } = context(new PdfPageError(404));
    await expect(processors['pdf.render'](ctx, job)).rejects.toBeInstanceOf(InvalidJobError);
    expect(put).not.toHaveBeenCalled();
  });

  it('leaves a 5xx to be retried', async () => {
    const { ctx, put } = context(new PdfPageError(503));
    await expect(processors['pdf.render'](ctx, job)).rejects.toBeInstanceOf(PdfPageError);
    expect(put).not.toHaveBeenCalled();
  });
});
