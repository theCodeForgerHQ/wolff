import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import type { ReactNode } from 'react';
import { makeStore } from '@/lib/store/makeStore';
import { StoreProvider } from '@/lib/store/StoreProvider';
import { initialQuoteDocumentState } from '@/lib/store/slices/quoteDocumentSlice';
import { useQuoteBuilderStore } from '@/lib/stores/quote-builder-store';
import { createBlock, type QuoteDocument, type TextBlock } from '@/lib/quotes/types';

function createTestDocument(overrides: Partial<QuoteDocument> = {}): QuoteDocument {
  return {
    id: 'doc-1',
    workspaceId: 'ws-1',
    clientId: 'client-1',
    projectId: null,
    quoteNumber: 'QT-0001',
    status: 'draft',
    title: 'Test Quote',
    currency: 'USD',
    issueDate: '2026-01-01',
    expirationDate: null,
    blocks: [createBlock('text', { html: '<p>Initial</p>' })],
    settings: {
      requireSignature: true,
      autoConvertToInvoice: false,
      depositRequired: false,
      depositType: 'percentage',
      depositValue: 50,
      showLineItemPrices: true,
      allowPartialAcceptance: false,
      currency: 'USD',
      taxInclusive: false,
    },
    totals: {
      subtotal: 0,
      discountType: null,
      discountValue: null,
      discountAmount: 0,
      taxTotal: 0,
      total: 0,
    },
    notes: '',
    terms: '',
    internalNotes: '',
    ...overrides,
  };
}

describe('Quote Builder RTK Store', () => {
  describe('undo/redo', () => {
    it('undoes 100 edits back to the start, and redoes them (Phase 4)', () => {
      const store = makeStore();
      const doc = createTestDocument();
      store.dispatch({ type: 'quoteDocument/initDocument', payload: doc });

      for (let i = 0; i < 100; i++) {
        store.dispatch({
          type: 'quoteDocument/addBlock',
          payload: { block: createBlock('text', { html: `<p>Edit ${i}</p>` }) },
        });
      }
      expect(store.getState().quoteDocument.present.document!.blocks).toHaveLength(101);

      for (let i = 0; i < 100; i++) store.dispatch({ type: '@@redux-undo/UNDO' });

      const undone = store.getState().quoteDocument;
      expect(undone.present.document!.blocks).toHaveLength(1);
      expect((undone.present.document!.blocks[0]! as TextBlock).content.html).toBe(
        '<p>Initial</p>'
      );

      for (let i = 0; i < 100; i++) store.dispatch({ type: '@@redux-undo/REDO' });

      const redone = store.getState().quoteDocument.present.document!.blocks;
      expect(redone).toHaveLength(101);
      expect((redone[100]! as TextBlock).content.html).toBe('<p>Edit 99</p>');
    });

    it('redoes undone edits', () => {
      const store = makeStore();
      const doc = createTestDocument();
      store.dispatch({ type: 'quoteDocument/initDocument', payload: doc });

      store.dispatch({
        type: 'quoteDocument/updateBlock',
        payload: { blockId: doc.blocks[0]!.id, content: { html: '<p>Changed</p>' } },
      });

      store.dispatch({ type: '@@redux-undo/UNDO' });
      store.dispatch({ type: '@@redux-undo/REDO' });

      const state = store.getState();
      expect((state.quoteDocument.present.document!.blocks[0]! as TextBlock).content.html).toBe(
        '<p>Changed</p>'
      );
    });

    it('does not record UI-only actions in history', () => {
      const store = makeStore();
      const doc = createTestDocument();
      store.dispatch({ type: 'quoteDocument/initDocument', payload: doc });

      store.dispatch({ type: 'builderUi/setZoom', payload: 150 });
      store.dispatch({ type: 'builderUi/selectBlock', payload: 'block-1' });

      const state = store.getState();
      expect(state.quoteDocument.past.length).toBe(0);
      expect(state.builderUi.selectedBlockId).toBe('block-1');
      expect(state.builderUi.zoom).toBe(150);
    });
  });

  describe('SSR isolation', () => {
    function Title() {
      return <h1>{useQuoteBuilderStore((state) => state.document?.title)}</h1>;
    }
    const page = (title: string) =>
      renderToString(
        <StoreProvider
          preloadedState={{
            quoteDocument: {
              past: [],
              future: [],
              present: {
                ...initialQuoteDocumentState,
                document: createTestDocument({ id: title, title }),
              },
            } as never,
          }}
        >
          <Title />
        </StoreProvider>
      );

    it('renders two concurrent requests with their own documents', async () => {
      // Interleave many server renders, as concurrent requests do.
      const titles = Array.from({ length: 20 }, (_, i) => `Quote ${i}`);
      const html = await Promise.all(
        titles.map(async (title, i) => {
          await new Promise((resolve) => setTimeout(resolve, (i * 7) % 5));
          return page(title);
        })
      );

      html.forEach((markup, i) => {
        expect(markup).toContain(`>${titles[i]}<`);
        expect(markup.match(/Quote \d+/g)).toEqual([titles[i]]);
      });
    });

    it('keeps no store in module state that one request could leak to another', () => {
      // A module-level `let` in the store code is how a store would be shared
      // across requests on the server (the removed active-store registry).
      const dirs = [join(__dirname, '../../../lib/store'), join(__dirname, '../../../lib/stores')];
      for (const dir of dirs) {
        for (const file of readdirSync(dir, { recursive: true }) as string[]) {
          if (!/\.tsx?$/.test(file)) continue;
          const source = readFileSync(join(dir, file), 'utf8');
          expect(source, file).not.toMatch(/^let /m);
        }
      }
    });

    it('StoreProvider creates one store per mount', () => {
      const wrapperA = ({ children }: { children: ReactNode }) => (
        <StoreProvider>{children}</StoreProvider>
      );
      const wrapperB = ({ children }: { children: ReactNode }) => (
        <StoreProvider>{children}</StoreProvider>
      );

      const { result: resultA } = renderHook(() => useQuoteBuilderStore(), { wrapper: wrapperA });
      const { result: resultB } = renderHook(() => useQuoteBuilderStore(), { wrapper: wrapperB });

      act(() => {
        resultA.current.initDocument(createTestDocument({ id: 'doc-a', title: 'Quote A' }));
      });
      act(() => {
        resultB.current.initDocument(createTestDocument({ id: 'doc-b', title: 'Quote B' }));
      });

      expect(resultA.current.document!.title).toBe('Quote A');
      expect(resultB.current.document!.title).toBe('Quote B');
    });
  });

  describe('listener persistence', () => {
    afterEach(() => {
      localStorage.clear();
    });

    it('writes dirty drafts to localStorage debounced', async () => {
      const store = makeStore();
      const doc = createTestDocument();
      store.dispatch({ type: 'quoteDocument/initDocument', payload: doc });

      store.dispatch({
        type: 'quoteDocument/updateBlock',
        payload: { blockId: doc.blocks[0]!.id, content: { html: '<p>Draft</p>' } },
      });

      expect(localStorage.getItem('wolff:quote-draft:doc-1')).toBeNull();

      await new Promise((resolve) => setTimeout(resolve, 1100));

      const stored = JSON.parse(localStorage.getItem('wolff:quote-draft:doc-1')!);
      expect(stored.document.blocks[0].content.html).toBe('<p>Draft</p>');
      expect(stored.isDirty).toBe(true);
    });
  });
});
