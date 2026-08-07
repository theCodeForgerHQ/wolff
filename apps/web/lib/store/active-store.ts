import { makeStore, type AppStore, type QuoteBuilderStoreState } from './makeStore';

let activeStore: AppStore | null = null;
let testStore: AppStore | null = null;

export function setActiveStore(store: AppStore | null): void {
  activeStore = store;
}

export function getActiveStore(): AppStore {
  if (activeStore) return activeStore;
  if (testStore) return testStore;
  throw new Error(
    'No active quote-builder store. Wrap the component with StoreProvider or call resetTestStore() in tests.'
  );
}

export function resetTestStore(preloadedState?: Partial<QuoteBuilderStoreState>): AppStore {
  testStore = makeStore(preloadedState);
  activeStore = testStore;
  return testStore;
}

export function getTestStore(): AppStore {
  if (!testStore) {
    testStore = makeStore();
    activeStore = testStore;
  }
  return testStore;
}
