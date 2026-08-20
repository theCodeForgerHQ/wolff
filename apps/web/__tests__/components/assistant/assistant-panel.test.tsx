import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AssistantPanel } from '@/components/assistant/assistant-panel';

function sse(events: [string, unknown][]): Response {
  const body = events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('');
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

const type = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
const enter = (label: string) =>
  act(() => {
    fireEvent.keyDown(screen.getByLabelText(label), { key: 'Enter' });
  });
const click = (role: 'button' | 'tab', name: string) =>
  act(() => {
    const element = screen.getByRole(role, { name });
    // Radix tabs switch on mousedown.
    if (role === 'tab') fireEvent.mouseDown(element, { button: 0 });
    fireEvent.click(element);
  });

describe('AssistantPanel', () => {
  const fetchMock = vi.fn();
  beforeEach(() => vi.stubGlobal('fetch', fetchMock));
  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  it('streams an answer with tool status and citation links', async () => {
    fetchMock.mockResolvedValue(
      sse([
        ['session', { sessionId: 's1' }],
        ['tool_call', { name: 'search_documents' }],
        ['token', { text: 'Due in ' }],
        ['token', { text: '15 days [1]' }],
        ['citation', { n: 1, source_type: 'quote', source_id: 'q1', label: 'Q-KS-001' }],
        ['citation', { n: 2, source_type: 'invoice', source_id: 'i1', label: 'INV-1' }],
        ['done', { sessionId: 's1' }],
      ])
    );
    render(<AssistantPanel open onOpenChange={() => {}} />);
    type('Ask the assistant', 'When is payment due?');
    await click('button', 'Send');

    expect(await screen.findByText('Due in 15 days [1]')).toBeInTheDocument();
    expect(screen.getByText('Searching your documents…')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '[1] Q-KS-001' })).toHaveAttribute(
      'href',
      '/quotes/q1'
    );
    expect(screen.getByRole('link', { name: '[2] INV-1' })).toHaveAttribute('href', '/invoices/i1');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/assistant/chat');
    expect(JSON.parse(init.body)).toEqual({ message: 'When is payment due?' });
  });

  it('sends the session id on the next question', async () => {
    fetchMock.mockImplementation(async () =>
      sse([
        ['session', { sessionId: 's9' }],
        ['token', { text: 'ok' }],
        ['done', { sessionId: 's9' }],
      ])
    );
    render(<AssistantPanel open onOpenChange={() => {}} />);
    type('Ask the assistant', 'one');
    await enter('Ask the assistant');
    await screen.findByText('ok');
    type('Ask the assistant', 'two');
    await enter('Ask the assistant');
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body)).toEqual({
      message: 'two',
      sessionId: 's9',
    });
  });

  it('shows a budget error with a retry button', async () => {
    fetchMock.mockResolvedValueOnce(
      sse([['error', { code: 'ai_budget_exceeded', retryAfter: 60 }]])
    );
    render(<AssistantPanel open onOpenChange={() => {}} />);
    type('Ask the assistant', 'hi');
    await enter('Ask the assistant');
    expect(await screen.findByRole('alert')).toHaveTextContent(/daily AI budget/i);
    fetchMock.mockResolvedValueOnce(
      sse([
        ['token', { text: 'back' }],
        ['done', {}],
      ])
    );
    await click('button', 'Retry');
    expect(await screen.findByText('back')).toBeInTheDocument();
  });

  it('drafts a quote and links to the builder', async () => {
    fetchMock.mockResolvedValue(
      Response.json({
        success: true,
        data: {
          quoteId: 'q7',
          quoteNumber: 'QT-0007',
          builderUrl: '/quotes/q7/builder',
          taxPending: true,
          warnings: ['GST will be calculated on save'],
          draft: {
            title: 'Logo design',
            currency: 'INR',
            line_items: [{ name: 'Logo design', qty: 1, rate: 25000 }],
            assumptions: ['One concept round'],
            confidence: 0.6,
          },
        },
      })
    );
    render(<AssistantPanel open onOpenChange={() => {}} />);
    await click('tab', 'Draft a quote');
    type('Quote brief', 'Draft a quote for Acme: logo');
    await click('button', 'Draft');

    expect(await screen.findByText('QT-0007')).toBeInTheDocument();
    expect(screen.getByText('Logo design', { selector: 'li *, li' })).toBeInTheDocument();
    expect(screen.getByText('GST will be calculated on save')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open in builder' })).toHaveAttribute(
      'href',
      '/quotes/q7/builder'
    );
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/assistant/drafts');
  });

  it('explains a refused draft', async () => {
    fetchMock.mockResolvedValue(
      Response.json(
        { success: false, error: { code: 'unknown_client', message: 'no client' } },
        { status: 422 }
      )
    );
    render(<AssistantPanel open onOpenChange={() => {}} />);
    await click('tab', 'Draft a quote');
    type('Quote brief', 'Draft a quote for Nobody: x');
    await click('button', 'Draft');
    expect(await screen.findByRole('alert')).toHaveTextContent(/couldn't find that client/i);
  });
});
