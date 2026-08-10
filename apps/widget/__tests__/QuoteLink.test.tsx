import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/preact';
import { QuoteLink } from '../src/components/QuoteLink';
import type { WidgetConfig } from '../src/types';

const config: WidgetConfig = {
  apiBaseUrl: 'https://api.example.com',
  appUrl: 'https://app.example.com',
  publishableKey: 'wolff_pk_test',
  mode: 'quote-link',
  target: document.createElement('div'),
};

describe('QuoteLink', () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    window.history.replaceState(null, '', '/');
  });

  it('links to the hosted portal for the token in the page URL, without calling the API', () => {
    window.history.replaceState(null, '', '/proposal?quote=quote-token-9');

    render(<QuoteLink config={config} />);

    const link = screen.getByRole('link', { name: /Open quote/ });
    expect(link.getAttribute('href')).toBe('https://app.example.com/q/quote-token-9');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('says so when the page URL has no quote token', () => {
    render(<QuoteLink config={config} />);

    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByRole('alert').textContent).not.toBe('');
  });
});
