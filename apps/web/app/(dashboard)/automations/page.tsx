import { Metadata } from 'next';
import { AutomationBuilder } from '@/components/automations/automation-builder';
import { getAutomationOptions, getAutomationRuns, getAutomations } from '@/lib/automations/actions';

export const metadata: Metadata = {
  title: 'Automations',
  description: 'Build follow-up automations with approval checkpoints',
};

export const dynamic = 'force-dynamic';

export default async function AutomationsPage() {
  const [automations, runs, approvals, options] = await Promise.all([
    getAutomations(),
    getAutomationRuns(),
    getAutomationRuns('waiting_approval'),
    getAutomationOptions(),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Automations</h1>
        <p className="text-muted-foreground text-sm">
          Build linear follow-up flows with human-in-the-loop approvals.
        </p>
      </div>
      <AutomationBuilder
        automations={automations}
        runs={runs}
        approvals={approvals}
        options={options}
      />
    </div>
  );
}
