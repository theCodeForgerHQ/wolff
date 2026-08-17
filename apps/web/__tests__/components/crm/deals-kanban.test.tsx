import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/crm/actions', () => ({ moveDeal: vi.fn(), createQuoteFromDeal: vi.fn() }));

import { DealsKanban, stageColumnCoordinates } from '@/components/crm/deals-kanban';
import type { DealsBoard } from '@/lib/crm/types';

const board: DealsBoard = {
  pipelineId: 'p1',
  pipelineName: 'Sales',
  stages: [
    { id: 's1', name: 'New', position: 0, probability: 10, kind: 'open' },
    { id: 's2', name: 'Won', position: 1, probability: 100, kind: 'won' },
  ],
  deals: [
    {
      id: 'd1',
      title: 'Acme retainer',
      value: 1000,
      currency: 'USD',
      stageId: 's1',
      clientName: 'Acme',
      ownerName: null,
      expectedCloseDate: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ],
};

describe('DealsKanban drag overlay', () => {
  it('keeps one draggable handle for a deal while it is picked up', async () => {
    render(<DealsKanban board={board} />);
    const handle = screen.getByRole('button', { name: 'Move Acme retainer to another stage' });

    handle.focus();
    await act(async () => {
      fireEvent.keyDown(handle, { key: ' ', code: 'Space' });
    });

    // The overlay shows the card, but must not register a second draggable
    // (or a second focusable handle) under the same deal id.
    expect(screen.getAllByText('Acme retainer')).toHaveLength(2);
    expect(
      screen.getAllByRole('button', { name: 'Move Acme retainer to another stage' })
    ).toHaveLength(1);
  });
});

describe('stageColumnCoordinates', () => {
  const rect = (left: number) => ({
    left,
    right: left + 100,
    top: 0,
    bottom: 400,
    width: 100,
    height: 400,
  });
  const columns = [rect(0), rect(200)];
  const context = (centre: number) =>
    ({
      context: {
        collisionRect: { ...rect(centre - 50), width: 100 },
        droppableRects: new Map(columns.map((r, i) => [`s${i}`, r])),
        droppableContainers: { getEnabled: () => columns.map((_, i) => ({ id: `s${i}` })) },
      },
    }) as unknown as Parameters<typeof stageColumnCoordinates>[1];
  const key = (code: string) => ({ code, preventDefault: vi.fn() }) as unknown as KeyboardEvent;

  it('jumps to the next column from inside one', () => {
    expect(stageColumnCoordinates(key('ArrowRight'), context(50))).toEqual({ x: 212, y: 64 });
  });

  it('does not move a card that is between columns, rather than sending it to the first', () => {
    expect(stageColumnCoordinates(key('ArrowRight'), context(150))).toBeUndefined();
  });
});
