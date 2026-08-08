import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { makeStore } from '@/lib/store/makeStore';
import { StoreProvider } from '@/lib/store/StoreProvider';
import { useQuoteBuilderStore, resetTestStore } from '@/lib/stores/quote-builder-store';
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
  beforeEach(() => {
    resetTestStore();
  });

  describe('undo/redo', () => {
    it('supports 100 edits and undoes all of them', () => {
      const store = resetTestStore();
      const doc = createTestDocument();
      store.dispatch({ type: 'quoteDocument/initDocument', payload: doc });

      // Perform 99 distinct block additions (limit 100 leaves room for the
      // base state plus 99 edits; the 100th edit would drop the base state).
      for (let i = 0; i < 99; i++) {
        store.dispatch({
          type: 'quoteDocument/addBlock',
          payload: { block: createBlock('text', { html: `<p>Edit ${i}</p>` }) },
        });
      }

      const stateAfterEdits = store.getState();
      expect(stateAfterEdits.quoteDocument.past.length).toBe(99);
      expect(stateAfterEdits.quoteDocument.present.document!.blocks).toHaveLength(100);

      // Undo all edits
      for (let i = 0; i < 99; i++) {
        store.dispatch({ type: '@@redux-undo/UNDO' });
      }

      const stateAfterUndo = store.getState();
      expect(stateAfterUndo.quoteDocument.present.document!.blocks).toHaveLength(1);
      expect(
        (stateAfterUndo.quoteDocument.present.document!.blocks[0]! as TextBlock).content.html
      ).toBe('<p>Initial</p>');
      expect(stateAfterUndo.quoteDocument.future.length).toBe(99);
    });

    it('redoes undone edits', () => {
      const store = resetTestStore();
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
      const store = resetTestStore();
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
    it('creates distinct stores for concurrent requests', () => {
      const storeA = makeStore();
      const storeB = makeStore();

      const docA = createTestDocument({ id: 'doc-a', title: 'Quote A' });
      const docB = createTestDocument({ id: 'doc-b', title: 'Quote B' });

      storeA.dispatch({ type: 'quoteDocument/initDocument', payload: docA });
      storeB.dispatch({ type: 'quoteDocument/initDocument', payload: docB });

      expect(storeA.getState().quoteDocument.present.document!.title).toBe('Quote A');
      expect(storeB.getState().quoteDocument.present.document!.title).toBe('Quote B');
      expect(storeA.getState().quoteDocument.present.document!.id).not.toBe(
        storeB.getState().quoteDocument.present.document!.id
      );
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
      const store = resetTestStore();
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
