'use client';

import { useState } from 'react';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type {
  AutomationListItem,
  AutomationOptions,
  AutomationRunListItem,
} from '@/lib/automations/types';
import { AutomationEditor } from './automation-editor';
import { AutomationList } from './automation-list';
import { ApprovalsInbox, RunTimeline } from './run-activity';

interface Props {
  automations: AutomationListItem[];
  runs: AutomationRunListItem[];
  approvals: AutomationRunListItem[];
  options: AutomationOptions;
}

/**
 * Follow-up automations: the flows, their runs with an audit
 * log, and the approvals inbox for the human checkpoints.
 */
export function AutomationBuilder({ automations, runs, approvals, options }: Props) {
  const [editing, setEditing] = useState<AutomationListItem | null>(null);
  const [isOpen, setIsOpen] = useState(false);

  const open = (automation: AutomationListItem | null) => {
    setEditing(automation);
    setIsOpen(true);
  };

  return (
    <Tabs defaultValue="builder" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <TabsList>
          <TabsTrigger value="builder">Flows</TabsTrigger>
          <TabsTrigger value="runs">Run timeline</TabsTrigger>
          <TabsTrigger value="approvals">
            Approvals
            {approvals.length > 0 && (
              <span className="ml-1.5 rounded-full bg-amber-500 px-1.5 text-[11px] font-semibold tabular-nums text-amber-950">
                {approvals.length}
              </span>
            )}
          </TabsTrigger>
        </TabsList>
        <Button onClick={() => open(null)}>
          <Plus className="mr-2 h-4 w-4" aria-hidden /> New automation
        </Button>
      </div>

      <TabsContent value="builder">
        <AutomationList automations={automations} options={options} onOpen={open} />
      </TabsContent>
      <TabsContent value="runs">
        <RunTimeline runs={runs} />
      </TabsContent>
      <TabsContent value="approvals">
        <ApprovalsInbox approvals={approvals} />
      </TabsContent>

      <AutomationEditor
        open={isOpen}
        onOpenChange={setIsOpen}
        automation={editing}
        options={options}
      />
    </Tabs>
  );
}
