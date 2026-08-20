import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { AssistantLauncher } from '@/components/assistant/assistant-launcher';

describe('AssistantLauncher', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('shows the button when the AI service is up', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ available: true })));
    render(<AssistantLauncher />);
    expect(await screen.findByRole('button', { name: 'Open the assistant' })).toBeInTheDocument();
  });

  it.each([
    ['unavailable', () => Promise.resolve(Response.json({ available: false }))],
    ['a failed status call', () => Promise.reject(new Error('offline'))],
    ['an error status', () => Promise.resolve(new Response('', { status: 500 }))],
  ])('renders nothing for %s', async (_label, answer) => {
    const fetchMock = vi.fn(answer);
    vi.stubGlobal('fetch', fetchMock);
    const { container } = render(<AssistantLauncher />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container).toBeEmptyDOMElement();
  });
});
