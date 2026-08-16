import { act } from 'react';
import { renderToString } from 'react-dom/server';
import { hydrateRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RecentActivity } from '@/components/dashboard/recent-activity';
import type { ActivityItem } from '@/lib/dashboard/types';

describe('RecentActivity hydration', () => {
  afterEach(() => vi.useRealTimers());

  it('hydrates without a mismatch when the relative time has moved on', async () => {
    const rendered = new Date('2026-10-03T10:00:00Z');
    // An event 12 seconds before the server render, as a portal visit right
    // before opening the dashboard produces.
    const activities = [
      {
        id: 'a1',
        type: 'invoice_viewed',
        title: 'Invoice INV-0003 viewed',
        date: new Date(rendered.getTime() - 12_000).toISOString(),
        entityId: 'inv-1',
      },
    ] as unknown as ActivityItem[];

    vi.useFakeTimers({ now: rendered, toFake: ['Date'] });
    const html = renderToString(<RecentActivity activities={activities} />);
    // The browser hydrates a few seconds later: "12 seconds ago" is now "15".
    vi.setSystemTime(new Date(rendered.getTime() + 3_000));

    const container = document.createElement('div');
    container.innerHTML = html;
    document.body.appendChild(container);
    const recoverable: unknown[] = [];
    await act(async () => {
      hydrateRoot(container, <RecentActivity activities={activities} />, {
        onRecoverableError: (error) => recoverable.push(error),
      });
    });

    expect(recoverable).toEqual([]);
    container.remove();
  });
});
