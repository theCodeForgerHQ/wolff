'use client';

import { useState, type ReactNode } from 'react';
import { Provider } from 'react-redux';
import { makeStore, type QuoteBuilderStoreState } from './makeStore';
import type { AppStore } from './makeStore';

interface StoreProviderProps {
  children: ReactNode;
  preloadedState?: Partial<QuoteBuilderStoreState>;
}

export function StoreProvider({ children, preloadedState }: StoreProviderProps) {
  // One store per mount (per request on the server), never shared through a
  // module.
  const [store] = useState<AppStore>(() => makeStore(preloadedState));

  return <Provider store={store}>{children}</Provider>;
}
