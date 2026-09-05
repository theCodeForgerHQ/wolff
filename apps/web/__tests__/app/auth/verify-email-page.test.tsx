import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const params = vi.hoisted(() => ({ value: new URLSearchParams() }));
vi.mock('next/navigation', () => ({ useSearchParams: () => params.value }));

import VerifyEmailPage from '@/app/(auth)/verify-email/page';

describe('verify-email page', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset().mockResolvedValue({ ok: true, json: async () => ({ success: true }) });
    vi.stubGlobal('fetch', fetchMock);
  });

  // The resend route needs the address: an unverified user has no session.
  it('sends the address from the sign-up redirect when resending', async () => {
    params.value = new URLSearchParams({ email: 'new@example.com' });
    render(<VerifyEmailPage />);
    fireEvent.click(await screen.findByRole('button', { name: /resend/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/auth/resend-verification');
    expect(JSON.parse(init.body)).toEqual({ email: 'new@example.com' });
    expect(await screen.findByText(/verification email sent/i)).toBeTruthy();
  });

  it('asks for the address when there is none in the URL', async () => {
    params.value = new URLSearchParams();
    render(<VerifyEmailPage />);
    fireEvent.change(await screen.findByLabelText(/email/i), {
      target: { value: 'typed@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: /resend/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({ email: 'typed@example.com' });
  });
});
