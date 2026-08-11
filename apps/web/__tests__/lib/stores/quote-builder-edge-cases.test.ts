import { describe, it, expect, beforeEach } from 'vitest';
import { enableMapSet } from 'immer';
import { quoteBuilderFacade } from '@/lib/stores/quote-builder-store';
import { makeStore, type AppStore } from '@/lib/store/makeStore';

let testStore: AppStore = makeStore();
import type { QuoteDocument, QuoteBlock, ServiceItemBlock } from '@/lib/quotes/types';

enableMapSet();

function createServiceItem(overrides: Partial<ServiceItemBlock['content']> = {}): ServiceItemBlock {
  return {
    id: crypto.randomUUID(),
    type: 'service-item',
    content: {
      name: 'Test Service',
      description: '',
      quantity: 1,
      rate: 100,
      unit: 'hour',
      taxRate: null,
      rateCardId: null,
      ...overrides,
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function createTestDocument(blocks: QuoteBlock[] = []): QuoteDocument {
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
    blocks,
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
  };
}

describe('Quote Builder Edge Cases', () => {
  beforeEach(() => {
    // Reset the store
    testStore = makeStore();
  });

  describe('Negative Values', () => {
    it('clamps negative quantity to zero in total calculation', () => {
      const store = quoteBuilderFacade(testStore).getState();
      const item = createServiceItem({ quantity: -5, rate: 100 });
      const doc = createTestDocument([item]);
      store.initDocument(doc);
      store.recalculateTotals();

      const state = quoteBuilderFacade(testStore).getState();
      // Negative quantity is clamped to 0 via Math.max(0, ...)
      expect(state.document!.totals.subtotal).toBe(0);
      expect(state.document!.totals.total).toBeGreaterThanOrEqual(0);
    });

    it('clamps negative rate to zero in total calculation', () => {
      const store = quoteBuilderFacade(testStore).getState();
      const item = createServiceItem({ quantity: 1, rate: -500 });
      const doc = createTestDocument([item]);
      store.initDocument(doc);
      store.recalculateTotals();

      const state = quoteBuilderFacade(testStore).getState();
      expect(state.document!.totals.subtotal).toBe(0);
    });
  });

  describe('Discount Bounds', () => {
    it('caps percentage discount at 100%', () => {
      const store = quoteBuilderFacade(testStore).getState();
      const item = createServiceItem({ quantity: 1, rate: 1000 });
      const doc = createTestDocument([item]);
      doc.totals.discountType = 'percentage';
      doc.totals.discountValue = 150; // 150% should be capped
      store.initDocument(doc);
      store.recalculateTotals();

      const state = quoteBuilderFacade(testStore).getState();
      // 150% capped to 100% of 1000 = 1000 discount
      expect(state.document!.totals.discountAmount).toBe(1000);
      expect(state.document!.totals.total).toBe(0); // 1000 - 1000 + 0 tax
    });

    it('clamps negative discount to zero', () => {
      const store = quoteBuilderFacade(testStore).getState();
      const item = createServiceItem({ quantity: 2, rate: 500 });
      const doc = createTestDocument([item]);
      doc.totals.discountType = 'fixed';
      doc.totals.discountValue = -200; // Negative should clamp to 0
      store.initDocument(doc);
      store.recalculateTotals();

      const state = quoteBuilderFacade(testStore).getState();
      expect(state.document!.totals.discountAmount).toBe(0);
      expect(state.document!.totals.subtotal).toBe(1000); // 2 * 500
    });

    it('caps fixed discount at subtotal', () => {
      const store = quoteBuilderFacade(testStore).getState();
      const item = createServiceItem({ quantity: 1, rate: 100 });
      const doc = createTestDocument([item]);
      doc.totals.discountType = 'fixed';
      doc.totals.discountValue = 500; // More than subtotal
      store.initDocument(doc);
      store.recalculateTotals();

      const state = quoteBuilderFacade(testStore).getState();
      // Fixed discount capped at subtotal
      expect(state.document!.totals.discountAmount).toBe(100);
      expect(state.document!.totals.total).toBe(0); // 100 - 100 + 0 tax
    });
  });

  describe('Zero and Extreme Values', () => {
    it('handles zero quantity gracefully', () => {
      const store = quoteBuilderFacade(testStore).getState();
      const item = createServiceItem({ quantity: 0, rate: 100 });
      const doc = createTestDocument([item]);
      store.initDocument(doc);
      store.recalculateTotals();

      const state = quoteBuilderFacade(testStore).getState();
      expect(state.document!.totals.subtotal).toBe(0);
      expect(state.document!.totals.total).toBe(0);
    });

    it('handles very large amounts without overflow', () => {
      const store = quoteBuilderFacade(testStore).getState();
      const item = createServiceItem({ quantity: 999999, rate: 999999 });
      const doc = createTestDocument([item]);
      store.initDocument(doc);
      store.recalculateTotals();

      const state = quoteBuilderFacade(testStore).getState();
      expect(state.document!.totals.subtotal).toBe(999999 * 999999);
      expect(Number.isFinite(state.document!.totals.total)).toBe(true);
    });

    it('handles empty blocks array', () => {
      const store = quoteBuilderFacade(testStore).getState();
      const doc = createTestDocument([]);
      store.initDocument(doc);
      store.recalculateTotals();

      const state = quoteBuilderFacade(testStore).getState();
      expect(state.document!.totals.subtotal).toBe(0);
      expect(state.document!.totals.total).toBe(0);
    });
  });

  describe('Tax Calculation', () => {
    it('calculates tax correctly on service items', () => {
      const store = quoteBuilderFacade(testStore).getState();
      const item = createServiceItem({ quantity: 2, rate: 100, taxRate: 10 });
      const doc = createTestDocument([item]);
      store.initDocument(doc);
      store.recalculateTotals();

      const state = quoteBuilderFacade(testStore).getState();
      // 2 * 100 = 200 subtotal, 10% tax = 20
      expect(state.document!.totals.subtotal).toBe(200);
      expect(state.document!.totals.taxTotal).toBe(20);
      expect(state.document!.totals.total).toBe(220);
    });

    it('clamps negative tax rate to zero', () => {
      const store = quoteBuilderFacade(testStore).getState();
      const item = createServiceItem({ quantity: 1, rate: 100, taxRate: -10 });
      const doc = createTestDocument([item]);
      store.initDocument(doc);
      store.recalculateTotals();

      const state = quoteBuilderFacade(testStore).getState();
      // Negative tax rate clamped to 0
      expect(state.document!.totals.taxTotal).toBe(0);
    });
  });

  describe('Block Operations', () => {
    it('initDocument sets document and clears dirty flag', () => {
      const store = quoteBuilderFacade(testStore).getState();
      const block: QuoteBlock = {
        id: 'block-1',
        type: 'header',
        content: { text: 'Test', level: 2, alignment: 'left' },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      const doc = createTestDocument([block]);
      store.initDocument(doc);

      const state = quoteBuilderFacade(testStore).getState();
      expect(state.document).not.toBeNull();
      expect(state.isDirty).toBe(false);
      expect(state.document!.blocks).toHaveLength(1);
    });

    it('selectBlock updates selectedBlockId', () => {
      const store = quoteBuilderFacade(testStore).getState();
      const doc = createTestDocument([]);
      store.initDocument(doc);

      store.selectBlock('some-block-id');
      expect(quoteBuilderFacade(testStore).getState().selectedBlockId).toBe('some-block-id');

      store.selectBlock(null);
      expect(quoteBuilderFacade(testStore).getState().selectedBlockId).toBeNull();
    });

    it('updateBlock modifies block content and marks dirty', () => {
      const block: QuoteBlock = {
        id: 'block-1',
        type: 'header',
        content: { text: 'Original', level: 1, alignment: 'left' },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      const doc = createTestDocument([block]);

      const store = quoteBuilderFacade(testStore).getState();
      store.initDocument(doc);
      expect(quoteBuilderFacade(testStore).getState().isDirty).toBe(false);

      quoteBuilderFacade(testStore).getState().updateBlock('block-1', { text: 'Updated' });
      expect(quoteBuilderFacade(testStore).getState().isDirty).toBe(true);
      const updatedBlock = quoteBuilderFacade(testStore).getState().document!.blocks[0]! as any;
      expect(updatedBlock.content.text).toBe('Updated');
    });

    it('togglePreviewMode clears selection', () => {
      const store = quoteBuilderFacade(testStore).getState();
      const doc = createTestDocument([]);
      store.initDocument(doc);
      store.selectBlock('some-id');

      quoteBuilderFacade(testStore).getState().togglePreviewMode();
      const state = quoteBuilderFacade(testStore).getState();
      expect(state.previewMode).toBe(true);
      expect(state.selectedBlockId).toBeNull();
    });
  });

  describe('Zoom Bounds', () => {
    it('clamps zoom below minimum', () => {
      const store = quoteBuilderFacade(testStore).getState();
      store.setZoom(10);
      expect(quoteBuilderFacade(testStore).getState().zoom).toBe(50);
    });

    it('clamps zoom above maximum', () => {
      const store = quoteBuilderFacade(testStore).getState();
      store.setZoom(300);
      expect(quoteBuilderFacade(testStore).getState().zoom).toBe(200);
    });
  });
});
