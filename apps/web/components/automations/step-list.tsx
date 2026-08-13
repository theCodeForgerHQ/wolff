'use client';

import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { AnimatePresence, motion } from 'motion/react';
import { GripVertical, Trash2 } from 'lucide-react';
import { Controller, useFieldArray, useFormContext } from 'react-hook-form';
import type { CreateAutomationInput } from '@wolff/contracts';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import type { AutomationOptions } from '@/lib/automations/types';
import { STEP_META, STEP_ORDER } from './step-meta';

/**
 * The steps of an automation as a vertical rail: drag (or Space + arrows on
 * the handle) to reorder, each step with its own fields. Insertions and
 * removals animate with `motion`; MotionConfig higher up turns that off for
 * people who prefer reduced motion.
 */
export function StepList({ options }: { options: AutomationOptions }) {
  const { control, formState } = useFormContext<CreateAutomationInput>();
  const { fields, append, remove, move } = useFieldArray({ control, name: 'steps' });
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );
  const position = (id: unknown) => fields.findIndex((f) => f.id === id) + 1;
  const announcements: Announcements = {
    onDragStart: ({ active }) =>
      `Picked up step ${position(active.id)}. Up and down arrows move it, Space drops it.`,
    onDragOver: ({ active, over }) =>
      over ? `Step ${position(active.id)} is now at position ${position(over.id)}.` : '',
    onDragEnd: ({ active, over }) =>
      over ? `Step dropped at position ${position(over.id)}.` : 'Step dropped.',
    onDragCancel: () => 'Reordering cancelled.',
  };

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    move(position(active.id) - 1, position(over.id) - 1);
  };

  return (
    <div className="space-y-3">
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        accessibility={{ announcements }}
        onDragEnd={onDragEnd}
      >
        <SortableContext items={fields.map((f) => f.id)} strategy={verticalListSortingStrategy}>
          <ol className="relative space-y-2" aria-label="Steps">
            {/* The rail the step markers sit on. */}
            <span aria-hidden className="bg-border absolute bottom-4 left-[19px] top-4 w-px" />
            <AnimatePresence initial={false}>
              {fields.map((field, index) => (
                <SortableStep
                  key={field.id}
                  id={field.id}
                  index={index}
                  options={options}
                  onRemove={fields.length > 1 ? () => remove(index) : undefined}
                />
              ))}
            </AnimatePresence>
          </ol>
        </SortableContext>
      </DndContext>
      {formState.errors.steps?.root?.message && (
        <p className="text-destructive text-sm">{formState.errors.steps.root.message}</p>
      )}
      <div className="flex flex-wrap items-center gap-2 pl-10">
        <span className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
          Add step
        </span>
        {STEP_ORDER.map((type) => {
          const { icon: Icon, label } = STEP_META[type];
          return (
            <Button
              key={type}
              type="button"
              variant="outline"
              size="sm"
              className="h-8"
              disabled={fields.length >= 20}
              onClick={() => append(STEP_META[type].create())}
            >
              <Icon className="mr-1.5 h-3.5 w-3.5" aria-hidden />
              {label}
            </Button>
          );
        })}
      </div>
    </div>
  );
}

function SortableStep({
  id,
  index,
  options,
  onRemove,
}: {
  id: string;
  index: number;
  options: AutomationOptions;
  onRemove?: () => void;
}) {
  const { watch } = useFormContext<CreateAutomationInput>();
  const type = watch(`steps.${index}.type`);
  const meta = STEP_META[type];
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
  });

  return (
    // motion animates the item in and out; dnd-kit moves the inner element
    // while it is dragged. Kept on separate elements so the two transforms
    // never fight over the same style.
    <motion.li
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, height: 0 }}
      transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
      className={cn('relative', isDragging && 'z-10')}
      data-testid="automation-step"
    >
      <div
        ref={setNodeRef}
        style={{ transform: CSS.Translate.toString(transform), transition }}
        className="flex gap-3"
      >
        <span
          aria-hidden
          className={cn(
            'relative z-[1] mt-2 flex h-10 w-10 shrink-0 items-center justify-center rounded-full ring-1',
            meta.tone
          )}
        >
          <meta.icon className="h-4 w-4" />
        </span>
        <div
          className={cn(
            'bg-card flex-1 rounded-lg border p-3 transition-shadow',
            isDragging && 'shadow-lg'
          )}
        >
          <div className="flex items-start justify-between gap-2">
            <div>
              <p className="text-sm font-medium">
                <span className="text-muted-foreground mr-1.5 tabular-nums">Step {index + 1}</span>
                {meta.label}
              </p>
              <p className="text-muted-foreground text-xs">{meta.hint}</p>
            </div>
            <div className="flex items-center">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-8 w-8 cursor-grab active:cursor-grabbing"
                aria-label={`Reorder step ${index + 1}`}
                {...attributes}
                {...listeners}
              >
                <GripVertical className="h-4 w-4" />
              </Button>
              {onRemove && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="text-muted-foreground hover:text-destructive h-8 w-8"
                  aria-label={`Remove step ${index + 1}`}
                  onClick={onRemove}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              )}
            </div>
          </div>
          <StepFields index={index} type={type} options={options} />
        </div>
      </div>
    </motion.li>
  );
}

function StepFields({
  index,
  type,
  options,
}: {
  index: number;
  type: keyof typeof STEP_META;
  options: AutomationOptions;
}) {
  const { control, register, formState } = useFormContext<CreateAutomationInput>();
  const errors = formState.errors.steps?.[index] as
    Record<string, { message?: string }> | undefined;
  const fieldId = (name: string) => `step-${index}-${name}`;
  const error = (name: string) =>
    errors?.[name]?.message ? (
      <p id={`${fieldId(name)}-error`} className="text-destructive text-xs">
        {name === 'templateId' || name === 'stageId' ? 'Choose one' : errors[name]!.message}
      </p>
    ) : null;

  if (type === 'wait') {
    return (
      <div className="mt-3 flex items-center gap-2">
        <Label htmlFor={fieldId('days')} className="text-xs">
          Days
        </Label>
        <Input
          id={fieldId('days')}
          type="number"
          min={0}
          max={365}
          className="h-8 w-24"
          aria-invalid={Boolean(errors?.days)}
          {...register(`steps.${index}.days` as const, { valueAsNumber: true })}
        />
        {error('days')}
      </div>
    );
  }

  const picker = (
    name: 'templateId' | 'stageId' | 'role',
    label: string,
    items: { value: string; label: string }[],
    empty: string
  ) => (
    <div className="mt-3 grid gap-1.5">
      <Label htmlFor={fieldId(name)} className="text-xs">
        {label}
      </Label>
      <Controller
        control={control}
        name={`steps.${index}.${name}` as `steps.${number}.role`}
        render={({ field }) => (
          <Select value={field.value || undefined} onValueChange={field.onChange}>
            <SelectTrigger
              id={fieldId(name)}
              className="h-8"
              aria-invalid={Boolean(errors?.[name])}
              aria-describedby={errors?.[name] ? `${fieldId(name)}-error` : undefined}
            >
              <SelectValue placeholder={items.length ? 'Choose…' : empty} />
            </SelectTrigger>
            <SelectContent>
              {items.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      />
      {error(name)}
    </div>
  );

  if (type === 'send_email') {
    return picker(
      'templateId',
      'Email template',
      options.templates.map((t) => ({ value: t.id, label: t.name })),
      'No email templates yet'
    );
  }
  if (type === 'move_deal') {
    return picker(
      'stageId',
      'Target stage',
      options.stages.map((s) => ({ value: s.id, label: `${s.pipelineName} · ${s.name}` })),
      'No pipeline stages yet'
    );
  }
  if (type === 'approval') {
    return picker(
      'role',
      'Who can approve',
      [
        { value: 'owner', label: 'Owner' },
        { value: 'admin', label: 'Admin or owner' },
        { value: 'member', label: 'Any member' },
      ],
      ''
    );
  }
  return null;
}
