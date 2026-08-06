'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { DataTable } from '@/components/ui/data-table/data-table';
import { getLeadColumns, leadStatusOptions } from './leads-columns';
import type { LeadListItem, PaginatedLeads } from '@/lib/crm/types';
import { Target, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { deleteLead, convertLead } from '@/lib/crm/actions';
import { toast } from 'sonner';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
interface LeadsDataTableProps {
  data: PaginatedLeads;
  onCreateClick?: () => void;
}

export function LeadsDataTable({ data, onCreateClick }: LeadsDataTableProps) {
  const router = useRouter();
  const [selectedRows, setSelectedRows] = useState<LeadListItem[]>([]);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [convertId, setConvertId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const handleDelete = async () => {
    if (!deleteId) return;
    setIsLoading(true);
    try {
      await deleteLead(deleteId);
      toast.success('Lead deleted');
      setDeleteId(null);
      router.refresh();
    } catch {
      toast.error('Failed to delete lead');
    } finally {
      setIsLoading(false);
    }
  };

  const handleConvert = async () => {
    if (!convertId) return;
    setIsLoading(true);
    try {
      const result = await convertLead(convertId);
      toast.success('Lead converted to deal');
      setConvertId(null);
      router.push(`/deals/${result.dealId}`);
    } catch {
      toast.error('Failed to convert lead');
      setIsLoading(false);
    }
  };

  const columns = getLeadColumns({
    onView: (lead) => router.push(`/leads/${lead.id}`),
    onEdit: (lead) => router.push(`/leads/${lead.id}/edit`),
    onDelete: (lead) => setDeleteId(lead.id),
    onConvert: (lead) => setConvertId(lead.id),
  });

  const emptyState = (
    <div className="flex flex-col items-center justify-center py-16">
      <Target className="text-muted-foreground mb-4 h-12 w-12" />
      <h3 className="text-lg font-medium">No leads found</h3>
      <p className="text-muted-foreground mb-4">Add your first lead to get started</p>
      <Button onClick={onCreateClick}>
        <Plus className="mr-2 h-4 w-4" />
        Add Lead
      </Button>
    </div>
  );

  return (
    <>
      <DataTable
        columns={columns}
        data={data.data}
        filterKey="name"
        filterPlaceholder="Search leads..."
        statusOptions={leadStatusOptions}
        statusFilterKey="status"
        onRowSelect={setSelectedRows}
        emptyState={emptyState}
        bulkActions={[
          {
            label: 'Delete selected',
            icon: <Trash2 className="mr-2 h-4 w-4" />,
            variant: 'destructive',
            onClick: () => {
              // Bulk delete not implemented in core; use first selected for safety
              const first = selectedRows[0];
              if (first) setDeleteId(first.id);
            },
          },
        ]}
      />

      <AlertDialog open={!!deleteId} onOpenChange={() => setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete lead?</AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone. The lead will be soft-deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isLoading}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={isLoading}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isLoading ? 'Deleting...' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!convertId} onOpenChange={() => setConvertId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Convert lead to deal?</AlertDialogTitle>
            <AlertDialogDescription>
              A client and deal will be created in the default pipeline.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isLoading}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleConvert} disabled={isLoading}>
              {isLoading ? 'Converting...' : 'Convert'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
