import { Suspense } from 'react';
import { getSavedLineItems } from '@/lib/saved-items/actions';
import { getWorkspaceCurrency } from '@/lib/settings/actions';
import { InvoiceItemsClient } from './invoice-items-client';
import { Skeleton } from '@/components/ui/skeleton';

export const metadata = {
  title: 'Invoice Items',
  description: 'Manage reusable line items for quotes and invoices.',
};

export const dynamic = 'force-dynamic';

export default function InvoiceItemsPage() {
  return (
    <Suspense fallback={<TableSkeleton />}>
      <InvoiceItemsContent />
    </Suspense>
  );
}

async function InvoiceItemsContent() {
  const [items, currency] = await Promise.all([getSavedLineItems(), getWorkspaceCurrency()]);
  return <InvoiceItemsClient initialItems={items} currency={currency} />;
}

function TableSkeleton() {
  return (
    <div className="space-y-3 rounded-md border p-4">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="flex items-center gap-4">
          <Skeleton className="h-4 w-4" />
          <Skeleton className="h-4 max-w-[200px] flex-1" />
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-4 w-24" />
        </div>
      ))}
    </div>
  );
}
