'use client';

import { cn } from '@/lib/utils';
import type { ColumnsBlock, QuoteBlock } from '@/lib/quotes/types';
import { useQuoteBuilderStore } from '@/lib/stores/quote-builder-store';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Label } from '@/components/ui/label';

interface ColumnsBlockContentProps {
  block: ColumnsBlock;
}

const ratioStyles: Record<ColumnsBlock['content']['ratio'], { left: string; right: string }> = {
  '50-50': { left: 'w-1/2', right: 'w-1/2' },
  '33-67': { left: 'w-1/3', right: 'w-2/3' },
  '67-33': { left: 'w-2/3', right: 'w-1/3' },
  '25-75': { left: 'w-1/4', right: 'w-3/4' },
  '75-25': { left: 'w-3/4', right: 'w-1/4' },
};

const gapStyles: Record<ColumnsBlock['content']['gap'], string> = {
  sm: 'gap-2',
  md: 'gap-4',
  lg: 'gap-8',
};

// TODO Bug #54: Column child blocks render only `{childBlock.type}` (e.g. "text")
// instead of actual content. Needs a block renderer component that dispatches to
// the correct block content component (TextBlockContent, ImageBlockContent, etc.)
// based on childBlock.type.
export function ColumnsBlockContent({ block }: ColumnsBlockContentProps) {
  const { updateBlock, selectedBlockId, previewMode } = useQuoteBuilderStore();
  const isEditing = selectedBlockId === block.id && !previewMode;

  const handleChange = (
    field: keyof typeof block.content,
    value: ColumnsBlock['content']['ratio'] | ColumnsBlock['content']['gap']
  ) => {
    updateBlock(block.id, { [field]: value });
  };

  const ratio = ratioStyles[block.content.ratio] || ratioStyles['50-50'];
  const gap = gapStyles[block.content.gap] || gapStyles['md'];

  if (isEditing) {
    return (
      <div className="bg-card space-y-4 rounded-lg border p-4">
        <div className="flex gap-4">
          <div className="flex-1">
            <Label className="text-muted-foreground text-xs">Column Ratio</Label>
            <Select
              value={block.content.ratio}
              onValueChange={(value) =>
                handleChange('ratio', value as ColumnsBlock['content']['ratio'])
              }
            >
              <SelectTrigger className="mt-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="50-50">50% / 50%</SelectItem>
                <SelectItem value="33-67">33% / 67%</SelectItem>
                <SelectItem value="67-33">67% / 33%</SelectItem>
                <SelectItem value="25-75">25% / 75%</SelectItem>
                <SelectItem value="75-25">75% / 25%</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex-1">
            <Label className="text-muted-foreground text-xs">Gap Size</Label>
            <Select
              value={block.content.gap}
              onValueChange={(value) =>
                handleChange('gap', value as ColumnsBlock['content']['gap'])
              }
            >
              <SelectTrigger className="mt-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="sm">Small</SelectItem>
                <SelectItem value="md">Medium</SelectItem>
                <SelectItem value="lg">Large</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className={cn('flex', gap)}>
          <div
            className={cn(
              'border-muted-foreground/30 text-muted-foreground flex min-h-[100px] items-center justify-center rounded-md border-2 border-dashed p-4 text-sm',
              ratio.left
            )}
          >
            Left Column
            {block.content.leftContent.length > 0 && (
              <span className="ml-1">({block.content.leftContent.length} items)</span>
            )}
          </div>
          <div
            className={cn(
              'border-muted-foreground/30 text-muted-foreground flex min-h-[100px] items-center justify-center rounded-md border-2 border-dashed p-4 text-sm',
              ratio.right
            )}
          >
            Right Column
            {block.content.rightContent.length > 0 && (
              <span className="ml-1">({block.content.rightContent.length} items)</span>
            )}
          </div>
        </div>

        <p className="text-muted-foreground text-center text-xs">
          Drag blocks into columns to add content (coming soon)
        </p>
      </div>
    );
  }

  return (
    <div className={cn('flex', gap)}>
      <div className={cn('min-h-[60px]', ratio.left)}>
        {block.content.leftContent.length > 0 ? (
          <div className="space-y-2">
            {block.content.leftContent.map((childBlock) => (
              <div key={childBlock.id} className="bg-muted/50 rounded p-3 text-sm">
                {childBlock.type}
              </div>
            ))}
          </div>
        ) : (
          <div className="border-muted-foreground/20 text-muted-foreground flex h-full min-h-[60px] items-center justify-center rounded-md border-2 border-dashed text-sm">
            Empty
          </div>
        )}
      </div>
      <div className={cn('min-h-[60px]', ratio.right)}>
        {block.content.rightContent.length > 0 ? (
          <div className="space-y-2">
            {block.content.rightContent.map((childBlock) => (
              <div key={childBlock.id} className="bg-muted/50 rounded p-3 text-sm">
                {childBlock.type}
              </div>
            ))}
          </div>
        ) : (
          <div className="border-muted-foreground/20 text-muted-foreground flex h-full min-h-[60px] items-center justify-center rounded-md border-2 border-dashed text-sm">
            Empty
          </div>
        )}
      </div>
    </div>
  );
}
