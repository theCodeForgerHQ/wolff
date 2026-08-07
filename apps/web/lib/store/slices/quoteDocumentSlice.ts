import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { QuoteDocument, QuoteSettings, QuoteTotals } from '@/lib/quotes/types';

export interface QuoteDocumentState {
  document: QuoteDocument | null;
  isDirty: boolean;
  isSaving: boolean;
  lastSavedAt: string | null;
}

export const initialQuoteDocumentState: QuoteDocumentState = {
  document: null,
  isDirty: false,
  isSaving: false,
  lastSavedAt: null,
};

const DEFAULT_TOTALS: QuoteTotals = {
  subtotal: 0,
  discountType: null,
  discountValue: null,
  discountAmount: 0,
  taxTotal: 0,
  total: 0,
};

const computeTotals = (document: QuoteDocument): QuoteTotals => {
  let subtotal = 0;
  let taxTotal = 0;

  const calculateItems = (blocks: QuoteDocument['blocks']) => {
    for (const block of blocks) {
      if (block.type === 'service-item') {
        const quantity = Math.max(0, block.content.quantity || 0);
        const rate = Math.max(0, block.content.rate || 0);
        const lineTotal = quantity * rate;
        subtotal += lineTotal;
        if (block.content.taxRate) {
          taxTotal += lineTotal * (Math.max(0, block.content.taxRate) / 100);
        }
      }
      if (block.type === 'service-group') {
        calculateItems(block.content.items);
      }
      if (block.type === 'columns') {
        calculateItems(block.content.leftContent);
        calculateItems(block.content.rightContent);
      }
    }
  };

  calculateItems(document.blocks);

  let discountAmount = 0;
  if (document.totals.discountType && document.totals.discountValue) {
    const discountValue = Math.max(0, document.totals.discountValue);
    if (document.totals.discountType === 'percentage') {
      discountAmount = subtotal * (Math.min(100, discountValue) / 100);
    } else {
      discountAmount = Math.min(subtotal, discountValue);
    }
  }

  if (subtotal > 0 && discountAmount > 0) {
    taxTotal = taxTotal * ((subtotal - discountAmount) / subtotal);
  }

  return {
    subtotal,
    discountType: document.totals.discountType,
    discountValue: document.totals.discountValue,
    discountAmount,
    taxTotal,
    total: subtotal - discountAmount + taxTotal,
  };
};

export const quoteDocumentSlice = createSlice({
  name: 'quoteDocument',
  initialState: initialQuoteDocumentState,
  reducers: {
    initDocument: (state, action: PayloadAction<QuoteDocument>) => {
      state.document = action.payload;
      state.isDirty = false;
      state.document.totals = computeTotals(state.document);
    },

    resetDocument: (state, action: PayloadAction<QuoteDocument>) => {
      state.document = action.payload;
      state.isDirty = false;
      state.isSaving = false;
      state.lastSavedAt = null;
    },

    updateTitle: (state, action: PayloadAction<string>) => {
      if (state.document) {
        state.document.title = action.payload;
        state.isDirty = true;
      }
    },

    updateProjectId: (state, action: PayloadAction<string | null>) => {
      if (state.document) {
        state.document.projectId = action.payload;
        state.isDirty = true;
      }
    },

    updateNotes: (state, action: PayloadAction<string>) => {
      if (state.document) {
        state.document.notes = action.payload;
        state.isDirty = true;
      }
    },

    updateTerms: (state, action: PayloadAction<string>) => {
      if (state.document) {
        state.document.terms = action.payload;
        state.isDirty = true;
      }
    },

    updateInternalNotes: (state, action: PayloadAction<string>) => {
      if (state.document) {
        state.document.internalNotes = action.payload;
        state.isDirty = true;
      }
    },

    updateSettings: (state, action: PayloadAction<Partial<QuoteSettings>>) => {
      if (state.document) {
        state.document.settings = { ...state.document.settings, ...action.payload };
        state.isDirty = true;
      }
    },

    updateClientId: (state, action: PayloadAction<string>) => {
      if (state.document) {
        state.document.clientId = action.payload;
        state.isDirty = true;
      }
    },

    updateContractTemplateId: (state, action: PayloadAction<string | null>) => {
      if (state.document) {
        state.document.contractTemplateId = action.payload;
        state.isDirty = true;
      }
    },

    addBlock: (
      state,
      action: PayloadAction<{ block: QuoteDocument['blocks'][number]; index?: number }>
    ) => {
      if (state.document) {
        const { block, index } = action.payload;
        if (index !== undefined) {
          state.document.blocks.splice(index, 0, block);
        } else {
          state.document.blocks.push(block);
        }
        state.isDirty = true;
        state.document.totals = computeTotals(state.document);
      }
    },

    addBlockAfter: (
      state,
      action: PayloadAction<{ blockId: string; newBlock: QuoteDocument['blocks'][number] }>
    ) => {
      if (state.document) {
        const index = state.document.blocks.findIndex((b) => b.id === action.payload.blockId);
        if (index !== -1) {
          state.document.blocks.splice(index + 1, 0, action.payload.newBlock);
          state.isDirty = true;
          state.document.totals = computeTotals(state.document);
        }
      }
    },

    updateBlock: (
      state,
      action: PayloadAction<{ blockId: string; content: Record<string, unknown> }>
    ) => {
      if (state.document) {
        const updateInBlocks = (blocks: QuoteDocument['blocks']): boolean => {
          for (const block of blocks) {
            if (block.id === action.payload.blockId) {
              const updated = { ...action.payload.content };
              if (
                'quantity' in updated &&
                typeof updated.quantity === 'number' &&
                updated.quantity < 0
              ) {
                updated.quantity = 0;
              }
              if ('rate' in updated && typeof updated.rate === 'number' && updated.rate < 0) {
                updated.rate = 0;
              }
              block.content = { ...block.content, ...updated } as typeof block.content;
              block.updatedAt = new Date().toISOString();
              state.isDirty = true;
              return true;
            }
            if (block.type === 'service-group') {
              if (updateInBlocks(block.content.items)) return true;
            }
            if (block.type === 'columns') {
              if (updateInBlocks(block.content.leftContent)) return true;
              if (updateInBlocks(block.content.rightContent)) return true;
            }
          }
          return false;
        };

        if (updateInBlocks(state.document.blocks)) {
          state.document.totals = computeTotals(state.document);
        }
      }
    },

    removeBlock: (state, action: PayloadAction<string>) => {
      if (state.document) {
        const removeFromBlocks = (blocks: QuoteDocument['blocks']): boolean => {
          const index = blocks.findIndex((b) => b.id === action.payload);
          if (index !== -1) {
            blocks.splice(index, 1);
            state.isDirty = true;
            return true;
          }
          for (const block of blocks) {
            if (block.type === 'service-group') {
              if (removeFromBlocks(block.content.items)) return true;
            }
            if (block.type === 'columns') {
              if (removeFromBlocks(block.content.leftContent)) return true;
              if (removeFromBlocks(block.content.rightContent)) return true;
            }
          }
          return false;
        };

        if (removeFromBlocks(state.document.blocks)) {
          state.document.totals = computeTotals(state.document);
        }
      }
    },

    moveBlock: (state, action: PayloadAction<{ fromIndex: number; toIndex: number }>) => {
      if (state.document) {
        const { fromIndex, toIndex } = action.payload;
        const [removed] = state.document.blocks.splice(fromIndex, 1);
        if (removed) {
          state.document.blocks.splice(toIndex, 0, removed);
          state.isDirty = true;
        }
      }
    },

    duplicateBlock: (state, action: PayloadAction<string>) => {
      if (state.document) {
        const duplicateInBlocks = (blocks: QuoteDocument['blocks']): boolean => {
          const index = blocks.findIndex((b) => b.id === action.payload);
          if (index !== -1) {
            const original = blocks[index]!;
            const duplicate: QuoteDocument['blocks'][number] = {
              ...(structuredClone(original) as QuoteDocument['blocks'][number]),
              id: crypto.randomUUID(),
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            };
            blocks.splice(index + 1, 0, duplicate);
            state.isDirty = true;
            return true;
          }
          for (const block of blocks) {
            if (block.type === 'service-group') {
              if (duplicateInBlocks(block.content.items)) return true;
            }
            if (block.type === 'columns') {
              if (duplicateInBlocks(block.content.leftContent)) return true;
              if (duplicateInBlocks(block.content.rightContent)) return true;
            }
          }
          return false;
        };

        if (duplicateInBlocks(state.document.blocks)) {
          state.document.totals = computeTotals(state.document);
        }
      }
    },

    setSaving: (state, action: PayloadAction<boolean>) => {
      state.isSaving = action.payload;
    },

    markSaved: (state) => {
      state.isDirty = false;
      state.isSaving = false;
      state.lastSavedAt = new Date().toISOString();
    },

    markDirty: (state) => {
      state.isDirty = true;
    },

    updateDocumentId: (state, action: PayloadAction<{ id: string; quoteNumber?: string }>) => {
      if (state.document) {
        state.document.id = action.payload.id;
        if (action.payload.quoteNumber) {
          state.document.quoteNumber = action.payload.quoteNumber;
        }
      }
    },

    recalculateTotals: (state) => {
      if (state.document) {
        state.document.totals = computeTotals(state.document);
      }
    },

    replaceDocument: (state, action: PayloadAction<QuoteDocument | null>) => {
      state.document = action.payload;
    },
  },
});

export const quoteDocumentActions = quoteDocumentSlice.actions;
export default quoteDocumentSlice.reducer;
