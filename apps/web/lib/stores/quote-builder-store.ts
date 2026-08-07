'use client';

import { useMemo, useEffect } from 'react';
import { useSelector, useDispatch, type TypedUseSelectorHook } from 'react-redux';
import type { QuoteDocument, QuoteBlock, QuoteSettings } from '@/lib/quotes/types';
import { createBlock } from '@/lib/quotes/types';
import {
  quoteDocumentActions,
  builderUiActions,
  type RootState,
  type AppDispatch,
} from '@/lib/store';
import { setActiveStore, getActiveStore, resetTestStore } from '@/lib/store/active-store';
import type { QuoteBuilderStoreState } from '@/lib/store/makeStore';
import type { AppStore } from '@/lib/store/makeStore';

export interface QuoteBuilderState {
  document: QuoteDocument | null;
  isDirty: boolean;
  isSaving: boolean;
  lastSavedAt: string | null;
  selectedBlockId: string | null;
  hoveredBlockId: string | null;
  showBlocksPanel: boolean;
  showPropertiesPanel: boolean;
  showRateCardPanel: boolean;
  previewMode: boolean;
  zoom: number;
  history: QuoteBlock[][];
  historyIndex: number;
}

export interface QuoteBuilderActions {
  initDocument: (doc: QuoteDocument) => void;
  resetDocument: () => void;
  updateTitle: (title: string) => void;
  updateProjectId: (projectId: string | null) => void;
  updateNotes: (notes: string) => void;
  updateTerms: (terms: string) => void;
  updateInternalNotes: (internalNotes: string) => void;
  updateSettings: (settings: Partial<QuoteSettings>) => void;
  updateClientId: (clientId: string) => void;
  updateContractTemplateId: (contractTemplateId: string | null) => void;
  addBlock: (block: QuoteBlock, index?: number) => void;
  addBlockAfter: (blockId: string, newBlock: QuoteBlock) => void;
  updateBlock: (blockId: string, content: Partial<QuoteBlock['content']>) => void;
  removeBlock: (blockId: string) => void;
  moveBlock: (fromIndex: number, toIndex: number) => void;
  duplicateBlock: (blockId: string) => void;
  selectBlock: (blockId: string | null) => void;
  setHoveredBlock: (blockId: string | null) => void;
  toggleBlocksPanel: () => void;
  togglePropertiesPanel: () => void;
  toggleRateCardPanel: () => void;
  togglePreviewMode: () => void;
  setZoom: (zoom: number) => void;
  setSaving: (saving: boolean) => void;
  markSaved: () => void;
  markDirty: () => void;
  updateDocumentId: (id: string, quoteNumber?: string) => void;
  undo: () => void;
  redo: () => void;
  pushHistory: () => void;
  recalculateTotals: () => void;
}

type QuoteBuilderStore = QuoteBuilderState & QuoteBuilderActions;

const DEFAULT_SETTINGS: QuoteSettings = {
  requireSignature: true,
  autoConvertToInvoice: false,
  depositRequired: false,
  depositType: 'percentage',
  depositValue: 50,
  showLineItemPrices: true,
  allowPartialAcceptance: false,
  currency: 'USD',
  taxInclusive: false,
};

const DEFAULT_TOTALS = {
  subtotal: 0,
  discountType: null as 'percentage' | 'fixed' | null,
  discountValue: null as number | null,
  discountAmount: 0,
  taxTotal: 0,
  total: 0,
};

const createEmptyDocument = (): QuoteDocument => ({
  id: '',
  workspaceId: '',
  clientId: '',
  projectId: null,
  quoteNumber: '',
  status: 'draft',
  title: 'Untitled Quote',
  currency: 'USD',
  issueDate: new Date().toISOString().split('T')[0] ?? new Date().toISOString().slice(0, 10),
  expirationDate: null,
  blocks: [
    createBlock('header', { text: 'Project Proposal', level: 1, alignment: 'left' }),
    createBlock('text', {
      html: '<p>Thank you for considering our services. Please find our proposal below.</p>',
      alignment: 'left',
    }),
    createBlock('divider', { style: 'solid', thickness: 1, color: '#e5e7eb' }),
    createBlock('header', { text: 'Services', level: 2, alignment: 'left' }),
  ],
  settings: DEFAULT_SETTINGS,
  totals: DEFAULT_TOTALS,
  notes: '',
  terms: '',
  internalNotes: '',
});

const useAppSelector: TypedUseSelectorHook<RootState> = useSelector;

function useActiveStore(): AppStore {
  const dispatch = useDispatch<AppDispatch>();
  useEffect(() => {
    // This hook is only called inside StoreProvider, so dispatch comes from the
    // nearest Provider. We cannot access the store instance directly from the
    // hook, but we can expose dispatch-bound actions. For imperative access we
    // rely on the active-store registry, which StoreProvider updates.
  }, [dispatch]);
  return getActiveStore();
}

function useActions(dispatch: AppDispatch): QuoteBuilderActions {
  return useMemo(
    () => ({
      initDocument: (doc) => dispatch(quoteDocumentActions.initDocument(doc)),
      resetDocument: () => dispatch(quoteDocumentActions.resetDocument(createEmptyDocument())),
      updateTitle: (title) => dispatch(quoteDocumentActions.updateTitle(title)),
      updateProjectId: (projectId) => dispatch(quoteDocumentActions.updateProjectId(projectId)),
      updateNotes: (notes) => dispatch(quoteDocumentActions.updateNotes(notes)),
      updateTerms: (terms) => dispatch(quoteDocumentActions.updateTerms(terms)),
      updateInternalNotes: (internalNotes) =>
        dispatch(quoteDocumentActions.updateInternalNotes(internalNotes)),
      updateSettings: (settings) => dispatch(quoteDocumentActions.updateSettings(settings)),
      updateClientId: (clientId) => dispatch(quoteDocumentActions.updateClientId(clientId)),
      updateContractTemplateId: (contractTemplateId) =>
        dispatch(quoteDocumentActions.updateContractTemplateId(contractTemplateId)),
      addBlock: (block, index) => dispatch(quoteDocumentActions.addBlock({ block, index })),
      addBlockAfter: (blockId, newBlock) =>
        dispatch(quoteDocumentActions.addBlockAfter({ blockId, newBlock })),
      updateBlock: (blockId, content) =>
        dispatch(quoteDocumentActions.updateBlock({ blockId, content })),
      removeBlock: (blockId) => dispatch(quoteDocumentActions.removeBlock(blockId)),
      moveBlock: (fromIndex, toIndex) =>
        dispatch(quoteDocumentActions.moveBlock({ fromIndex, toIndex })),
      duplicateBlock: (blockId) => dispatch(quoteDocumentActions.duplicateBlock(blockId)),
      selectBlock: (blockId) => dispatch(builderUiActions.selectBlock(blockId)),
      setHoveredBlock: (blockId) => dispatch(builderUiActions.setHoveredBlock(blockId)),
      toggleBlocksPanel: () => dispatch(builderUiActions.toggleBlocksPanel()),
      togglePropertiesPanel: () => dispatch(builderUiActions.togglePropertiesPanel()),
      toggleRateCardPanel: () => dispatch(builderUiActions.toggleRateCardPanel()),
      togglePreviewMode: () => dispatch(builderUiActions.togglePreviewMode()),
      setZoom: (zoom) => dispatch(builderUiActions.setZoom(zoom)),
      setSaving: (saving) => dispatch(quoteDocumentActions.setSaving(saving)),
      markSaved: () => dispatch(quoteDocumentActions.markSaved()),
      markDirty: () => dispatch(quoteDocumentActions.markDirty()),
      updateDocumentId: (id, quoteNumber) =>
        dispatch(quoteDocumentActions.updateDocumentId({ id, quoteNumber })),
      undo: () => dispatch({ type: '@@redux-undo/UNDO' }),
      redo: () => dispatch({ type: '@@redux-undo/REDO' }),
      pushHistory: () => {
        // redux-undo records history automatically; this is a no-op for compatibility.
      },
      recalculateTotals: () => dispatch(quoteDocumentActions.recalculateTotals()),
    }),
    [dispatch]
  );
}

function selectQuoteBuilderState(state: RootState): QuoteBuilderState {
  const present = state.quoteDocument.present;
  return {
    document: present.document,
    isDirty: present.isDirty,
    isSaving: present.isSaving,
    lastSavedAt: present.lastSavedAt,
    selectedBlockId: state.builderUi.selectedBlockId,
    hoveredBlockId: state.builderUi.hoveredBlockId,
    showBlocksPanel: state.builderUi.showBlocksPanel,
    showPropertiesPanel: state.builderUi.showPropertiesPanel,
    showRateCardPanel: state.builderUi.showRateCardPanel,
    previewMode: state.builderUi.previewMode,
    zoom: state.builderUi.zoom,
    history: state.quoteDocument.past.map((p) => p.document?.blocks ?? []),
    historyIndex: state.quoteDocument.past.length,
  };
}

export function useQuoteBuilderStore(): QuoteBuilderStore;
export function useQuoteBuilderStore<T>(selector: (state: QuoteBuilderStore) => T): T;
export function useQuoteBuilderStore<T>(
  selector?: (state: QuoteBuilderStore) => T
): QuoteBuilderStore | T {
  const dispatch = useDispatch<AppDispatch>();
  const state = useAppSelector(selectQuoteBuilderState);
  const actions = useActions(dispatch);

  const store = useMemo(
    () => ({ ...state, ...actions }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state, dispatch]
  );

  if (selector) {
    return selector(store);
  }
  return store;
}

useQuoteBuilderStore.getState = (): QuoteBuilderStore => {
  const store = getActiveStore();
  const state = store.getState();
  const boundActions: QuoteBuilderActions = {
    initDocument: (doc) => store.dispatch(quoteDocumentActions.initDocument(doc)),
    resetDocument: () => store.dispatch(quoteDocumentActions.resetDocument(createEmptyDocument())),
    updateTitle: (title) => store.dispatch(quoteDocumentActions.updateTitle(title)),
    updateProjectId: (projectId) => store.dispatch(quoteDocumentActions.updateProjectId(projectId)),
    updateNotes: (notes) => store.dispatch(quoteDocumentActions.updateNotes(notes)),
    updateTerms: (terms) => store.dispatch(quoteDocumentActions.updateTerms(terms)),
    updateInternalNotes: (internalNotes) =>
      store.dispatch(quoteDocumentActions.updateInternalNotes(internalNotes)),
    updateSettings: (settings) => store.dispatch(quoteDocumentActions.updateSettings(settings)),
    updateClientId: (clientId) => store.dispatch(quoteDocumentActions.updateClientId(clientId)),
    updateContractTemplateId: (contractTemplateId) =>
      store.dispatch(quoteDocumentActions.updateContractTemplateId(contractTemplateId)),
    addBlock: (block, index) => store.dispatch(quoteDocumentActions.addBlock({ block, index })),
    addBlockAfter: (blockId, newBlock) =>
      store.dispatch(quoteDocumentActions.addBlockAfter({ blockId, newBlock })),
    updateBlock: (blockId, content) =>
      store.dispatch(quoteDocumentActions.updateBlock({ blockId, content })),
    removeBlock: (blockId) => store.dispatch(quoteDocumentActions.removeBlock(blockId)),
    moveBlock: (fromIndex, toIndex) =>
      store.dispatch(quoteDocumentActions.moveBlock({ fromIndex, toIndex })),
    duplicateBlock: (blockId) => store.dispatch(quoteDocumentActions.duplicateBlock(blockId)),
    selectBlock: (blockId) => store.dispatch(builderUiActions.selectBlock(blockId)),
    setHoveredBlock: (blockId) => store.dispatch(builderUiActions.setHoveredBlock(blockId)),
    toggleBlocksPanel: () => store.dispatch(builderUiActions.toggleBlocksPanel()),
    togglePropertiesPanel: () => store.dispatch(builderUiActions.togglePropertiesPanel()),
    toggleRateCardPanel: () => store.dispatch(builderUiActions.toggleRateCardPanel()),
    togglePreviewMode: () => store.dispatch(builderUiActions.togglePreviewMode()),
    setZoom: (zoom) => store.dispatch(builderUiActions.setZoom(zoom)),
    setSaving: (saving) => store.dispatch(quoteDocumentActions.setSaving(saving)),
    markSaved: () => store.dispatch(quoteDocumentActions.markSaved()),
    markDirty: () => store.dispatch(quoteDocumentActions.markDirty()),
    updateDocumentId: (id, quoteNumber) =>
      store.dispatch(quoteDocumentActions.updateDocumentId({ id, quoteNumber })),
    undo: () => store.dispatch({ type: '@@redux-undo/UNDO' }),
    redo: () => store.dispatch({ type: '@@redux-undo/REDO' }),
    pushHistory: () => {
      // no-op: redux-undo records automatically
    },
    recalculateTotals: () => store.dispatch(quoteDocumentActions.recalculateTotals()),
  };
  return {
    ...selectQuoteBuilderState(state),
    ...boundActions,
  };
};

useQuoteBuilderStore.setState = (
  partial: Partial<QuoteBuilderState> | ((state: QuoteBuilderState) => Partial<QuoteBuilderState>)
): void => {
  const store = getActiveStore();
  const current = selectQuoteBuilderState(store.getState());
  const patch = typeof partial === 'function' ? partial(current) : partial;

  if ('document' in patch) {
    store.dispatch(quoteDocumentActions.replaceDocument(patch.document ?? null));
  }
  if ('isDirty' in patch) {
    if (patch.isDirty) store.dispatch(quoteDocumentActions.markDirty());
  }
  if ('isSaving' in patch) {
    store.dispatch(quoteDocumentActions.setSaving(patch.isSaving ?? false));
  }
  if ('lastSavedAt' in patch) {
    // Not directly settable; use markSaved if needed.
    if (patch.lastSavedAt) store.dispatch(quoteDocumentActions.markSaved());
  }
  if ('selectedBlockId' in patch) {
    store.dispatch(builderUiActions.selectBlock(patch.selectedBlockId ?? null));
  }
  if ('hoveredBlockId' in patch) {
    store.dispatch(builderUiActions.setHoveredBlock(patch.hoveredBlockId ?? null));
  }
  if ('showBlocksPanel' in patch) {
    store.dispatch(builderUiActions.setShowBlocksPanel(patch.showBlocksPanel ?? false));
  }
  if ('showPropertiesPanel' in patch) {
    store.dispatch(builderUiActions.setShowPropertiesPanel(patch.showPropertiesPanel ?? false));
  }
  if ('showRateCardPanel' in patch) {
    store.dispatch(builderUiActions.toggleRateCardPanel());
  }
  if ('previewMode' in patch) {
    store.dispatch(builderUiActions.togglePreviewMode());
  }
  if ('zoom' in patch) {
    store.dispatch(builderUiActions.setZoom(patch.zoom ?? 100));
  }
};

export { setActiveStore, resetTestStore, getActiveStore };
export type { QuoteBuilderStore };
