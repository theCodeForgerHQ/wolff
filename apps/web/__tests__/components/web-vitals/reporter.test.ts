import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendVital } from '@/components/web-vitals/reporter';

const metric = { name: 'LCP', value: 1200, id: 'v1', navigationType: 'navigate' };

describe('sendVital', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('sends with a beacon when the browser accepts it', () => {
    const sendBeacon = vi.fn(() => true);
    const fetchMock = vi.fn();
    vi.stubGlobal('navigator', { sendBeacon });
    vi.stubGlobal('fetch', fetchMock);

    sendVital(metric);

    expect(sendBeacon).toHaveBeenCalledWith('/api/vitals', expect.stringContaining('"LCP"'));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('falls back to a keepalive fetch when there is no beacon', () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
    vi.stubGlobal('navigator', {});
    vi.stubGlobal('fetch', fetchMock);

    sendVital(metric);

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/vitals',
      expect.objectContaining({ method: 'POST', keepalive: true })
    );
  });

  it('falls back to fetch when the beacon is refused', () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
    vi.stubGlobal('navigator', { sendBeacon: vi.fn(() => false) });
    vi.stubGlobal('fetch', fetchMock);

    sendVital(metric);

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('does nothing without a navigator', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('navigator', undefined);
    vi.stubGlobal('fetch', fetchMock);

    expect(() => sendVital(metric)).not.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
