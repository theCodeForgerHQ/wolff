'use client';

import { Fragment } from 'react';
import { ChevronRight, Workflow } from 'lucide-react';
import type { AutomationTrigger } from '@wolff/contracts';
import { cn } from '@/lib/utils';
import type { AutomationListItem, AutomationOptions } from '@/lib/automations/types';
import { STEP_META, TRIGGER_LABELS, describeStep } from './step-meta';

/**
 * Each automation as the flow it runs: trigger, then its steps in order,
 * with approval checkpoints standing out. One row per automation, so the
 * page reads as a list of processes rather than a grid of cards.
 */
export function AutomationList({
  automations,
  options,
  onOpen,
}: {
  automations: AutomationListItem[];
  options: AutomationOptions;
  onOpen: (automation: AutomationListItem) => void;
}) {
  if (automations.length === 0) {
    return (
      <div className="flex flex-col items-center rounded-xl border border-dashed px-6 py-14 text-center">
        <Workflow className="text-muted-foreground mb-3 h-8 w-8" aria-hidden />
        <p className="font-medium">No automations yet</p>
        <p className="text-muted-foreground mt-1 max-w-sm text-sm">
          Start with an overdue-invoice reminder, and put an approval before anything you would not
          send without looking.
        </p>
      </div>
    );
  }

  const names = (step: AutomationListItem['steps'][number]) => ({
    stage:
      step.type === 'move_deal'
        ? options.stages.find((s) => s.id === step.stageId)?.name
        : undefined,
    template:
      step.type === 'send_email'
        ? options.templates.find((t) => t.id === step.templateId)?.name
        : undefined,
  });

  return (
    <ul className="divide-y overflow-hidden rounded-xl border">
      {automations.map((automation) => (
        <li key={automation.id}>
          <button
            type="button"
            data-testid="automation-card"
            onClick={() => onOpen(automation)}
            className="hover:bg-muted/50 focus-visible:ring-ring focus-visible:outline-hidden group grid w-full gap-3 px-4 py-4 text-left transition-colors focus-visible:ring-2 sm:grid-cols-[minmax(10rem,14rem)_1fr_auto] sm:items-center"
          >
            <span className="min-w-0">
              <span className="text-muted-foreground block text-[11px] font-medium uppercase tracking-wider">
                {TRIGGER_LABELS[automation.trigger as AutomationTrigger]}
              </span>
              <span className="block truncate font-medium">{automation.name}</span>
            </span>

            <span className="flex flex-wrap items-center gap-1.5" aria-label="Steps">
              {automation.steps.map((step, index) => {
                const meta = STEP_META[step.type];
                return (
                  <Fragment key={index}>
                    {index > 0 && (
                      <ChevronRight className="text-muted-foreground h-3.5 w-3.5" aria-hidden />
                    )}
                    <span
                      className={cn(
                        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ring-1',
                        meta.tone
                      )}
                    >
                      <meta.icon className="h-3 w-3" aria-hidden />
                      {describeStep(step, names(step))}
                    </span>
                  </Fragment>
                );
              })}
            </span>

            <span
              className={cn(
                'inline-flex items-center gap-1.5 justify-self-start rounded-full px-2.5 py-1 text-xs font-medium sm:justify-self-end',
                automation.isActive
                  ? 'bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200'
                  : 'bg-muted text-muted-foreground'
              )}
            >
              <span
                aria-hidden
                className={cn(
                  'h-1.5 w-1.5 rounded-full',
                  automation.isActive ? 'bg-emerald-600' : 'bg-muted-foreground'
                )}
              />
              {automation.isActive ? 'Active' : 'Paused'}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
