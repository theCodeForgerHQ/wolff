'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Plus } from 'lucide-react';
import { LeadsDataTable } from './leads-data-table';
import { CreateLeadDialog } from './create-lead-dialog';
import type { PaginatedLeads } from '@/lib/crm/types';

interface LeadsPageClientProps {
  data: PaginatedLeads;
}

export function LeadsPageClient({ data }: LeadsPageClientProps) {
  const [showCreate, setShowCreate] = useState(false);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Leads</h1>
          <p className="text-muted-foreground text-sm">Track and convert prospective clients.</p>
        </div>
        <Button onClick={() => setShowCreate(true)}>
          <Plus className="mr-2 h-4 w-4" />
          Add Lead
        </Button>
      </div>

      <LeadsDataTable data={data} onCreateClick={() => setShowCreate(true)} />
      <CreateLeadDialog open={showCreate} onOpenChange={setShowCreate} />
    </div>
  );
}
