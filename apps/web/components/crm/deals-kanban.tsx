'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import {
  DndContext,
  DragOverlay,
  useDraggable,
  useDroppable,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Plus, Loader2, FileText } from 'lucide-react';
import { moveDeal, createQuoteFromDeal } from '@/lib/crm/actions';
import { formatCurrency } from '@/lib/utils';
import type { DealsBoard, DealListItem, DealStage } from '@/lib/crm/types';

interface DealsKanbanProps {
  board: DealsBoard;
  currency?: string;
}

function DealCard({
  deal,
  isOverlay,
  currency,
  onCreateQuote,
}: {
  deal: DealListItem;
  isOverlay?: boolean;
  currency?: string;
  onCreateQuote?: (deal: DealListItem) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: deal.id,
    data: { deal },
  });

  const style = {
    transform: CSS.Translate.toString(transform),
    opacity: isDragging ? 0.4 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...listeners}
      {...attributes}
      data-testid="deal-card"
      className={`bg-card cursor-grab rounded-lg border p-3 shadow-sm active:cursor-grabbing ${
        isOverlay ? 'rotate-2 shadow-lg' : ''
      }`}
    >
      <div className="font-medium">{deal.title}</div>
      <div className="text-muted-foreground text-sm">{deal.clientName ?? 'No client'}</div>
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
          <h3 className="font-medium">{stage.name}</h3>
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
      <DndContext onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
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
        <DragOverlay>{activeDeal ? <DealCard deal={activeDeal} isOverlay /> : null}</DragOverlay>
      </DndContext>
    </div>
  );
}
