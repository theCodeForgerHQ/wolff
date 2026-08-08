'use client';

import { useState, useEffect, type ReactNode } from 'react';
import { Provider } from 'react-redux';
import { makeStore, type QuoteBuilderStoreState } from './makeStore';
import type { AppStore } from './makeStore';
import { setActiveStore } from './active-store';

interface StoreProviderProps {
  children: ReactNode;
  preloadedState?: Partial<QuoteBuilderStoreState>;
}

export function StoreProvider({ children, preloadedState }: StoreProviderProps) {
  const [store] = useState<AppStore>(() => makeStore(preloadedState));

  useEffect(() => {
    setActiveStore(store);
    return () => {
      setActiveStore(null);
    };
  }, [store]);

  return <Provider store={store}>{children}</Provider>;
}
