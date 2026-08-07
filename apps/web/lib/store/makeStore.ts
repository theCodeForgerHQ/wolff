import { configureStore, type Action, type ThunkAction, type Reducer } from '@reduxjs/toolkit';
import undoable, { excludeAction, type StateWithHistory } from 'redux-undo';
import quoteDocumentReducer, {
  initialQuoteDocumentState,
  type QuoteDocumentState,
} from './slices/quoteDocumentSlice';
import builderUiReducer, {
  initialBuilderUiState,
  type BuilderUiState,
} from './slices/builderUiSlice';
import { persistenceMiddleware } from './listeners/persistence';

export interface QuoteBuilderStoreState {
  quoteDocument: StateWithHistory<QuoteDocumentState>;
  builderUi: BuilderUiState;
}

const TYPING_BURST_MS = 500;

const excludedFromHistory: string[] = [
  'quoteDocument/initDocument',
  'quoteDocument/resetDocument',
  'builderUi/selectBlock',
  'builderUi/setHoveredBlock',
  'builderUi/toggleBlocksPanel',
  'builderUi/togglePropertiesPanel',
  'builderUi/toggleRateCardPanel',
  'builderUi/togglePreviewMode',
  'builderUi/setZoom',
  'builderUi/setShowBlocksPanel',
  'builderUi/setShowPropertiesPanel',
  'builderUi/resetBuilderUi',
  'quoteDocument/setSaving',
  'quoteDocument/markSaved',
  'quoteDocument/markDirty',
  'quoteDocument/updateDocumentId',
  'quoteDocument/replaceDocument',
];

const groupBy = (action: Action): string | null => {
  if (action.type === 'quoteDocument/updateBlock') {
    return `${action.type}-${Math.floor(Date.now() / TYPING_BURST_MS)}`;
  }
  return null;
};

export const makeStore = (preloadedState?: Partial<QuoteBuilderStoreState>) => {
  const store = configureStore({
    reducer: {
      quoteDocument: undoable(quoteDocumentReducer, {
        limit: 100,
        filter: excludeAction(excludedFromHistory),
        groupBy,
        syncFilter: true,
      }) as Reducer<StateWithHistory<QuoteDocumentState>>,
      builderUi: builderUiReducer,
    },
    preloadedState: preloadedState
      ? {
          quoteDocument: {
            past: [],
            present: preloadedState.quoteDocument?.present ?? initialQuoteDocumentState,
            future: [],
            _latestUnfiltered: preloadedState.quoteDocument?.present ?? initialQuoteDocumentState,
            group: null,
          },
          builderUi: preloadedState.builderUi ?? initialBuilderUiState,
        }
      : undefined,
    middleware: (getDefaultMiddleware) =>
      getDefaultMiddleware({
        serializableCheck: {
          ignoredActions: ['quoteDocument/initDocument', 'quoteDocument/resetDocument'],
        },
      }).prepend(persistenceMiddleware.middleware),
  });
  return store;
};

export type AppStore = ReturnType<typeof makeStore>;
export type RootState = ReturnType<AppStore['getState']>;
export type AppDispatch = AppStore['dispatch'];
export type AppThunk<ReturnType = void> = ThunkAction<
  ReturnType,
  RootState,
  unknown,
  Action<string>
>;
