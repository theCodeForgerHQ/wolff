'use client';

import { forwardRef, useState, type CSSProperties, type HTMLAttributes } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import {
  DndContext,
  DragOverlay,
  KeyboardCode,
  KeyboardSensor,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type DragStartEvent,
  type KeyboardCoordinateGetter,
} from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Plus, Loader2, FileText, GripVertical } from 'lucide-react';
import { moveDeal, createQuoteFromDeal } from '@/lib/crm/actions';
import { formatCurrency } from '@/lib/utils';
import type { DealsBoard, DealListItem, DealStage } from '@/lib/crm/types';

/**
 * Keyboard moves (WCAG 2.1.1): with a deal picked up (Space or
 * Enter on its handle), Left/Right jump to the previous/next stage column
 * instead of nudging the card a few pixels; Space/Enter drops, Escape
 * cancels. dnd-kit's default getter moves 25 px per key, which takes a dozen
 * presses to cross one column.
 */
export const stageColumnCoordinates: KeyboardCoordinateGetter = (event, { context }) => {
  const { collisionRect, droppableRects, droppableContainers } = context;
  if (!collisionRect) return undefined;
  const step = event.code === KeyboardCode.Right ? 1 : event.code === KeyboardCode.Left ? -1 : 0;
  if (step === 0) return undefined;
  event.preventDefault();

  const columns = droppableContainers
    .getEnabled()
    .map((container) => droppableRects.get(container.id))
    .filter((rect): rect is NonNullable<typeof rect> => Boolean(rect))
    .sort((a, b) => a.left - b.left);
  const centre = collisionRect.left + collisionRect.width / 2;
  const current = columns.findIndex((rect) => centre >= rect.left && centre <= rect.right);
  // Between columns (or off the board) there is no column to step from;
  // stepping from -1 would land on the first column whatever the key.
  if (current === -1) return undefined;
  const target = columns[Math.min(Math.max(current + step, 0), columns.length - 1)];
  if (!target) return undefined;
  return { x: target.left + 12, y: target.top + 64 };
};

interface DealsKanbanProps {
  board: DealsBoard;
  currency?: string;
}

/**
 * The card as drawn. Has no dnd-kit hooks, so the DragOverlay can render it
 * without registering a second draggable under the dragged deal's id.
 */
const DealCardView = forwardRef<
  HTMLDivElement,
  {
    deal: DealListItem;
    isOverlay?: boolean;
    currency?: string;
    style?: CSSProperties;
    handleProps?: HTMLAttributes<HTMLButtonElement>;
    onCreateQuote?: (deal: DealListItem) => void;
  }
>(function DealCardView({ deal, isOverlay, currency, style, handleProps, onCreateQuote }, ref) {
  return (
    <div
      ref={ref}
      style={style}
      data-testid={isOverlay ? undefined : 'deal-card'}
      className={`bg-card rounded-lg border p-3 shadow-sm ${isOverlay ? 'rotate-2 shadow-lg' : ''}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="font-medium">{deal.title}</div>
          <div className="text-muted-foreground text-sm">{deal.clientName ?? 'No client'}</div>
        </div>
        {isOverlay ? (
          <span aria-hidden="true" className="text-muted-foreground p-1">
            <GripVertical className="h-4 w-4" />
          </span>
        ) : (
          <button
            type="button"
            aria-label={`Move ${deal.title} to another stage`}
            className="text-muted-foreground hover:text-foreground cursor-grab p-1 active:cursor-grabbing"
            {...handleProps}
          >
            <GripVertical className="h-4 w-4" />
          </button>
        )}
      </div>
      <div className="mt-2 flex items-center justify-between">
        <Badge variant="outline" className="text-xs">
          {formatCurrency(deal.value, currency ?? deal.currency)}
        </Badge>
        {deal.expectedCloseDate && (
          <span className="text-muted-foreground text-xs">
            {new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(
              deal.expectedCloseDate
            )}
          </span>
        )}
      </div>
      {onCreateQuote && (
        <Button
          data-testid="create-quote-button"
          variant="ghost"
          size="sm"
          className="mt-2 h-7 w-full text-xs"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onCreateQuote(deal);
          }}
        >
          <FileText className="mr-1 h-3 w-3" />
          Create Quote
        </Button>
      )}
    </div>
  );
});

function DealCard({
  deal,
  currency,
  onCreateQuote,
}: {
  deal: DealListItem;
  currency?: string;
  onCreateQuote?: (deal: DealListItem) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: deal.id,
    data: { deal },
  });

  return (
    <DealCardView
      ref={setNodeRef}
      deal={deal}
      currency={currency}
      onCreateQuote={onCreateQuote}
      style={{ transform: CSS.Translate.toString(transform), opacity: isDragging ? 0.4 : 1 }}
      handleProps={{ ...listeners, ...attributes }}
    />
  );
}

function StageColumn({
  stage,
  deals,
  currency,
  onCreateQuote,
}: {
  stage: DealStage;
  deals: DealListItem[];
  currency?: string;
  onCreateQuote?: (deal: DealListItem) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: stage.id, data: { stage } });
  const total = deals.reduce((sum, d) => sum + d.value, 0);

  return (
    <div
      ref={setNodeRef}
      className={`bg-muted/30 flex max-h-[calc(100vh-12rem)] min-w-[280px] flex-1 flex-col rounded-lg border ${
        isOver ? 'border-primary bg-primary/5' : ''
      }`}
    >
      <div className="border-b p-3">
        <div className="flex items-center justify-between">
          <h2 className="font-medium">{stage.name}</h2>
          <Badge variant="secondary" className="text-xs">
            {deals.length}
          </Badge>
        </div>
        <p className="text-muted-foreground text-xs">
          {formatCurrency(total, currency ?? deals[0]?.currency ?? 'USD')}
        </p>
      </div>
      <div className="flex-1 space-y-3 overflow-y-auto p-3">
        {deals.map((deal) => (
          <DealCard key={deal.id} deal={deal} currency={currency} onCreateQuote={onCreateQuote} />
        ))}
      </div>
    </div>
  );
}

export function DealsKanban({ board, currency = 'USD' }: DealsKanbanProps) {
  const router = useRouter();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: stageColumnCoordinates })
  );
  const stageName = (id: unknown) => board.stages.find((s) => s.id === id)?.name ?? 'no stage';
  const dealTitle = (id: unknown) => board.deals.find((d) => d.id === id)?.title ?? 'Deal';
  // What a screen reader hears while a deal is moved (dnd-kit live region).
  const announcements: Announcements = {
    onDragStart: ({ active }) =>
      `Picked up ${dealTitle(active.id)}. Left and right arrows move it between stages, Space drops it, Escape cancels.`,
    onDragOver: ({ active, over }) =>
      over
        ? `${dealTitle(active.id)} is over ${stageName(over.id)}.`
        : `${dealTitle(active.id)} is not over a stage.`,
    onDragEnd: ({ active, over }) =>
      over
        ? `${dealTitle(active.id)} dropped in ${stageName(over.id)}.`
        : `${dealTitle(active.id)} dropped outside the board; not moved.`,
    onDragCancel: ({ active }) => `Move of ${dealTitle(active.id)} cancelled.`,
  };
  const [deals, setDeals] = useState(board.deals);
  const [activeDeal, setActiveDeal] = useState<DealListItem | null>(null);
  const [isMoving, setIsMoving] = useState(false);
  const [isCreatingQuote, setIsCreatingQuote] = useState(false);

  const handleCreateQuote = async (deal: DealListItem) => {
    setIsCreatingQuote(true);
    try {
      const result = await createQuoteFromDeal(deal.id);
      toast.success('Quote created from deal');
      router.push(`/quotes/${result.quoteId}/edit`);
    } catch {
      toast.error('Failed to create quote');
      setIsCreatingQuote(false);
    }
  };

  const handleDragStart = (event: DragStartEvent) => {
    const deal = event.active.data.current?.deal as DealListItem | undefined;
    if (deal) setActiveDeal(deal);
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveDeal(null);
    if (!over) return;

    const dealId = active.id as string;
    const overId = over.id as string;
    const deal = deals.find((d) => d.id === dealId);
    if (!deal) return;

    const stageId = board.stages.find((s) => s.id === overId)?.id;
    if (!stageId || stageId === deal.stageId) return;

    // Optimistic update
    setDeals((prev) => prev.map((d) => (d.id === dealId ? { ...d, stageId } : d)));
    setIsMoving(true);
    try {
      await moveDeal({ dealId, stageId });
      toast.success('Deal moved');
      router.refresh();
    } catch {
      toast.error('Failed to move deal');
      // Rollback
      setDeals((prev) => prev.map((d) => (d.id === dealId ? deal : d)));
    } finally {
      setIsMoving(false);
    }
  };

  return (
    <div className="relative">
      {(isMoving || isCreatingQuote) && (
        <div className="bg-background/50 absolute inset-0 z-10 flex items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin" />
        </div>
      )}
      <DndContext
        sensors={sensors}
        accessibility={{ announcements }}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={() => setActiveDeal(null)}
      >
        <div className="flex gap-4 overflow-x-auto pb-4">
          {board.stages.map((stage) => (
            <StageColumn
              key={stage.id}
              stage={stage}
              deals={deals.filter((d) => d.stageId === stage.id)}
              currency={currency}
              onCreateQuote={handleCreateQuote}
            />
          ))}
          <div className="flex min-w-[200px] flex-col items-start justify-start">
            <Button variant="outline" className="w-full" onClick={() => router.push('/deals/new')}>
              <Plus className="mr-2 h-4 w-4" />
              Add Deal
            </Button>
          </div>
        </div>
        <DragOverlay>
          {activeDeal ? <DealCardView deal={activeDeal} currency={currency} isOverlay /> : null}
        </DragOverlay>
      </DndContext>
    </div>
  );
}
