import { Metadata } from 'next';
import { DealsKanban } from '@/components/crm/deals-kanban';
import { getDealsBoard } from '@/lib/crm/actions';
import { getWorkspaceCurrency } from '@/lib/settings/actions';

export const metadata: Metadata = {
  title: 'Deals',
  description: 'Manage your sales pipeline',
};

export const dynamic = 'force-dynamic';

export default async function DealsPage() {
  const [board, currency] = await Promise.all([getDealsBoard(), getWorkspaceCurrency()]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Deals</h1>
        <p className="text-muted-foreground text-sm">
          Drag deals between stages to update your pipeline.
        </p>
      </div>

      <DealsKanban board={board} currency={currency} />
    </div>
  );
}
