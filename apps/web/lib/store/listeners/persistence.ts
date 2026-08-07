import { createListenerMiddleware, type TypedStartListening } from '@reduxjs/toolkit';
import type { RootState, AppDispatch } from '../makeStore';

export const persistenceMiddleware = createListenerMiddleware();
export type AppStartListening = TypedStartListening<RootState, AppDispatch>;

const DEBOUNCE_MS = 1000;
const timers = new Map<string, ReturnType<typeof setTimeout>>();

function getStorageKey(quoteId: string): string {
  return `wolff:quote-draft:${quoteId}`;
}

persistenceMiddleware.startListening({
  predicate: (action, currentState, previousState) => {
    const current = currentState as RootState;
    const previous = previousState as RootState;
    return (
      current.quoteDocument.present.document?.id !== previous.quoteDocument.present.document?.id ||
      current.quoteDocument.present.isDirty !== previous.quoteDocument.present.isDirty ||
      current.quoteDocument.present.document?.blocks !==
        previous.quoteDocument.present.document?.blocks
    );
  },
  effect: (action, listenerApi) => {
    const state = listenerApi.getState() as RootState;
    const document = state.quoteDocument.present.document;
    const isDirty = state.quoteDocument.present.isDirty;

    if (typeof window === 'undefined' || !document?.id || !isDirty) return;

    const key = getStorageKey(document.id);
    const existing = timers.get(key);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      try {
        const payload = {
          document,
          isDirty,
          lastSavedAt: state.quoteDocument.present.lastSavedAt,
          timestamp: Date.now(),
        };
        localStorage.setItem(key, JSON.stringify(payload));
      } catch {
        // localStorage may be full or unavailable
      }
      timers.delete(key);
    }, DEBOUNCE_MS);

    timers.set(key, timer);
  },
});

export function loadDraftFromStorage(quoteId: string): {
  document: RootState['quoteDocument']['present']['document'];
  isDirty: boolean;
  lastSavedAt: string | null;
} | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(getStorageKey(quoteId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      document: RootState['quoteDocument']['present']['document'];
      isDirty: boolean;
      lastSavedAt: string | null;
      timestamp: number;
    };
    // Discard drafts older than 7 days
    if (Date.now() - parsed.timestamp > 7 * 24 * 60 * 60 * 1000) {
      localStorage.removeItem(getStorageKey(quoteId));
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function clearDraftFromStorage(quoteId: string): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.removeItem(getStorageKey(quoteId));
  } catch {
    // ignore
  }
}
