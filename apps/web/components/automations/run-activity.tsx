'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Check, Inbox, Loader2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { decideRun } from '@/lib/automations/actions';
import type { AutomationRunListItem } from '@/lib/automations/types';

const STATUS: Record<string, { label: string; className: string }> = {
  running: { label: 'Running', className: 'bg-primary/10 text-primary' },
  waiting_approval: {
    label: 'Waiting for approval',
    className: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
  },
  done: {
    label: 'Done',
    className: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200',
  },
  cancelled: { label: 'Cancelled', className: 'bg-muted text-muted-foreground' },
};

const when = (iso: string) =>
  new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(iso)
  );

/** Every run with its audit log on a vertical rail, newest run first. */
export function RunTimeline({ runs }: { runs: AutomationRunListItem[] }) {
  if (runs.length === 0) {
    return <p className="text-muted-foreground py-10 text-center text-sm">No runs yet.</p>;
  }
  return (
    <ol className="space-y-4">
      {runs.map((run) => {
        const status = STATUS[run.status] ?? STATUS.cancelled!;
        return (
          <li key={run.id} className="rounded-xl border p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="font-medium">{run.automationName}</p>
              <span
                className={cn('rounded-full px-2.5 py-0.5 text-xs font-medium', status.className)}
              >
                {status.label}
              </span>
            </div>
            {run.log.length > 0 ? (
              <ol className="border-border ml-1.5 mt-3 space-y-2 border-l pl-4">
                {run.log.map((entry, i) => (
                  <li key={i} className="relative text-sm">
                    <span
                      aria-hidden
                      className="bg-background ring-border absolute -left-[21px] top-1.5 h-2.5 w-2.5 rounded-full ring-2"
                    />
                    <span className="text-muted-foreground mr-2 text-xs tabular-nums">
                      <time dateTime={entry.at}>{when(entry.at)}</time>
                    </span>
                    Step {entry.stepIndex + 1}: {entry.message}
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-muted-foreground mt-2 text-sm">Started; nothing logged yet.</p>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * Runs stopped at an approval step. Approving continues the run (the worker
 * picks it up from the outbox); rejecting cancels it. Core checks the
 * approver's role and that the run is still waiting.
 */
export function ApprovalsInbox({ approvals }: { approvals: AutomationRunListItem[] }) {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  const [decided, setDecided] = useState<string[]>([]);
  const items = approvals.filter((run) => !decided.includes(run.id));

  const decide = async (id: string, approved: boolean) => {
    setPending(id);
    const result = await decideRun(id, approved);
    setPending(null);
    if (!result.success) {
      toast.error(result.error);
      return;
    }
    toast.success(approved ? 'Approved; the run continues' : 'Rejected; the run is cancelled');
    setDecided((ids) => [...ids, id]);
    router.refresh();
  };

  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center py-12 text-center">
        <Inbox className="text-muted-foreground mb-2 h-7 w-7" aria-hidden />
        <p className="text-muted-foreground text-sm">Nothing is waiting for you.</p>
      </div>
    );
  }

  return (
    <ul className="space-y-3">
      {items.map((run) => (
        <li
          key={run.id}
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-300 bg-amber-50/60 p-4 dark:border-amber-800 dark:bg-amber-950/30"
        >
          <div>
            <p className="font-medium">{run.automationName}</p>
            <p className="text-muted-foreground text-sm">
              Waiting for approval at step {run.currentStep + 1}.
            </p>
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={pending === run.id}
              onClick={() => decide(run.id, false)}
            >
              <X className="mr-1 h-4 w-4" aria-hidden /> Reject
            </Button>
            <Button size="sm" disabled={pending === run.id} onClick={() => decide(run.id, true)}>
              {pending === run.id ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <Check className="mr-1 h-4 w-4" aria-hidden />
              )}
              Approve
            </Button>
          </div>
        </li>
      ))}
    </ul>
  );
}
