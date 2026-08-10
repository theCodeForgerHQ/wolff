import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/preact';
import { LeadForm } from '../src/components/LeadForm';
import type { WidgetConfig } from '../src/types';

const config: WidgetConfig = {
  apiBaseUrl: 'https://api.example.com',
  appUrl: 'https://app.example.com',
  publishableKey: 'wolff_pk_test',
  mode: 'lead-form',
  target: document.createElement('div'),
};

describe('LeadForm', () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('submits a lead and shows success', async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, data: { message: 'Thanks!' } }),
    } as Response);

    let mockedNow = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => mockedNow);

    render(<LeadForm config={config} />);
    mockedNow += 3000;

    fireEvent.input(screen.getByLabelText(/Name/), { target: { value: 'Ada' } });
    fireEvent.input(screen.getByLabelText(/Email/), { target: { value: 'ada@example.com' } });
    fireEvent.submit(screen.getByRole('form'));

    const status = await screen.findByRole('status', {}, { timeout: 3000 });
    expect(status.textContent).toBe('Thanks!');

    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.example.com/v1/public/leads',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          name: 'Ada',
          email: 'ada@example.com',
          phone: '',
          company: '',
          message: '',
        }),
      })
    );
  });

  it('rejects submissions that fill the honeypot', async () => {
    render(<LeadForm config={config} />);

    fireEvent.input(screen.getByLabelText(/Name/), { target: { value: 'Bot' } });
    fireEvent.input(screen.getByLabelText(/Email/), { target: { value: 'bot@example.com' } });
    // Honeypot field is visually hidden but still in the DOM for tests.
    fireEvent.input(document.getElementById('ow-website')!, { target: { value: 'spam' } });
    fireEvent.submit(screen.getByRole('form'));

    await waitFor(() => {
      expect(document.querySelector('.ow-error')).not.toBeNull();
    });

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('rejects submissions that are too fast', async () => {
    render(<LeadForm config={config} />);

    fireEvent.input(screen.getByLabelText(/Name/), { target: { value: 'Bot' } });
    fireEvent.input(screen.getByLabelText(/Email/), { target: { value: 'bot@example.com' } });
    fireEvent.submit(screen.getByRole('form'));

    await waitFor(() => {
      expect(document.querySelector('.ow-error')).not.toBeNull();
    });

    expect(global.fetch).not.toHaveBeenCalled();
  });
});
