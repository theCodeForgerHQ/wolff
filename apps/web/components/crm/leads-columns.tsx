'use client';

import { ColumnDef } from '@tanstack/react-table';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { DataTableColumnHeader } from '@/components/ui/data-table/data-table-column-header';
import { DataTableRowActions } from '@/components/ui/data-table/data-table-row-actions';
import type { LeadListItem, LeadStatus, LeadSource } from '@/lib/crm/types';
import { Eye, Pencil, Trash2, ArrowRight } from 'lucide-react';

export const leadStatusOptions: { value: LeadStatus; label: string }[] = [
  { value: 'new', label: 'New' },
  { value: 'contacted', label: 'Contacted' },
  { value: 'qualified', label: 'Qualified' },
  { value: 'disqualified', label: 'Disqualified' },
  { value: 'converted', label: 'Converted' },
];

export const leadSourceOptions: { value: LeadSource; label: string }[] = [
  { value: 'manual', label: 'Manual' },
  { value: 'widget', label: 'Widget' },
  { value: 'api', label: 'API' },
  { value: 'import', label: 'Import' },
];

const statusVariant: Record<LeadStatus, 'default' | 'secondary' | 'outline' | 'destructive'> = {
  new: 'default',
  contacted: 'secondary',
  qualified: 'default',
  disqualified: 'destructive',
  converted: 'outline',
};

interface LeadColumnsOptions {
  onView?: (lead: LeadListItem) => void;
  onEdit?: (lead: LeadListItem) => void;
  onDelete?: (lead: LeadListItem) => void;
  onConvert?: (lead: LeadListItem) => void;
}

export function getLeadColumns(options: LeadColumnsOptions = {}): ColumnDef<LeadListItem>[] {
  const { onView, onEdit, onDelete, onConvert } = options;

  return [
    {
      id: 'select',
      header: ({ table }) => (
        <Checkbox
          checked={
            table.getIsAllPageRowsSelected() ||
            (table.getIsSomePageRowsSelected() && 'indeterminate')
          }
          onCheckedChange={(value) => table.toggleAllPageRowsSelected(!!value)}
          aria-label="Select all"
          className="translate-y-[2px]"
        />
      ),
      cell: ({ row }) => (
        <Checkbox
          checked={row.getIsSelected()}
          onCheckedChange={(value) => row.toggleSelected(!!value)}
          aria-label="Select row"
          className="translate-y-[2px]"
        />
      ),
      enableSorting: false,
      enableHiding: false,
    },
    {
      accessorKey: 'name',
      header: ({ column }) => <DataTableColumnHeader column={column} title="Lead" />,
      cell: ({ row }) => {
        const lead = row.original;
        const displayName = lead.name;
        const initials = displayName
          .split(' ')
          .map((n) => n[0])
          .join('')
          .toUpperCase()
          .slice(0, 2);

        return (
          <div className="flex items-center gap-3">
            <div className="bg-primary/10 text-primary flex h-8 w-8 items-center justify-center rounded-full text-xs font-medium">
              {initials}
            </div>
            <div>
              <div className="text-primary font-medium">{displayName}</div>
              <div className="text-muted-foreground text-sm">{lead.email}</div>
            </div>
          </div>
        );
      },
      filterFn: (row, id, value) => {
        const lead = row.original;
        const searchValue = (value as string).toLowerCase();
        return (
          lead.name.toLowerCase().includes(searchValue) ||
          (lead.company?.toLowerCase().includes(searchValue) ?? false) ||
          (lead.email?.toLowerCase().includes(searchValue) ?? false)
        );
      },
    },
    {
      accessorKey: 'company',
      header: ({ column }) => <DataTableColumnHeader column={column} title="Company" />,
      cell: ({ row }) => row.original.company ?? '—',
    },
    {
      accessorKey: 'source',
      header: ({ column }) => <DataTableColumnHeader column={column} title="Source" />,
      cell: ({ row }) => (
        <Badge variant="outline" className="capitalize">
          {row.original.source}
        </Badge>
      ),
      filterFn: (row, id, value) => (value as string[]).includes(row.getValue(id)),
    },
    {
      accessorKey: 'status',
      header: ({ column }) => <DataTableColumnHeader column={column} title="Status" />,
      cell: ({ row }) => {
        const status = row.original.status;
        return (
          <Badge variant={statusVariant[status]} className="capitalize">
            {status}
          </Badge>
        );
      },
      filterFn: (row, id, value) => (value as string[]).includes(row.getValue(id)),
    },
    {
      accessorKey: 'score',
      header: ({ column }) => <DataTableColumnHeader column={column} title="Score" />,
      cell: ({ row }) => row.original.score ?? '—',
    },
    {
      accessorKey: 'createdAt',
      header: ({ column }) => <DataTableColumnHeader column={column} title="Created" />,
      cell: ({ row }) =>
        new Intl.DateTimeFormat('en-US', { dateStyle: 'medium' }).format(row.original.createdAt),
    },
    {
      id: 'actions',
      cell: ({ row }) => (
        <DataTableRowActions
          row={row.original}
          showQuickActions={false}
          actions={[
            ...(onView
              ? [
                  {
                    label: 'View Details',
                    icon: <Eye className="mr-2 h-4 w-4" />,
                    onClick: onView,
                  },
                ]
              : []),
            ...(onEdit
              ? [
                  {
                    label: 'Edit',
                    icon: <Pencil className="mr-2 h-4 w-4" />,
                    onClick: onEdit,
                  },
                ]
              : []),
            ...(onConvert && row.original.status !== 'converted'
              ? [
                  {
                    label: 'Convert to Deal',
                    icon: <ArrowRight className="mr-2 h-4 w-4" />,
                    onClick: onConvert,
                  },
                ]
              : []),
            ...(onDelete
              ? [
                  {
                    label: 'Delete',
                    icon: <Trash2 className="mr-2 h-4 w-4" />,
                    onClick: onDelete,
                    variant: 'destructive' as const,
                  },
                ]
              : []),
          ]}
        />
      ),
    },
  ];
}
