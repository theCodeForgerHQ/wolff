'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft,
  Building2,
  Mail,
  Phone,
  Pencil,
  Trash2,
  User,
  MoreHorizontal,
  Plus,
  CheckCircle2,
  ExternalLink,
  Link2,
  Send,
  Lock,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { deleteProject, deactivateProject, reactivateProject } from '@/lib/projects/actions';
import { formatCurrency, formatDate, cn } from '@/lib/utils';
import type {
  ProjectDetail as ProjectDetailType,
  ProjectStats,
  ProjectActivity,
  ProjectNote,
  ProjectContract,
} from '@/lib/projects/types';
import { toast } from 'sonner';

interface ProjectDetailProps {
  project: ProjectDetailType;
  stats: ProjectStats;
  activity: ProjectActivity[];
  notes: ProjectNote[];
  contracts: ProjectContract[];
  currency?: string;
}

export function ProjectDetail({
  project,
  stats,
  activity,
  notes,
  contracts,
  currency = 'USD',
}: ProjectDetailProps) {
  const router = useRouter();
  const [showDeleteDialog, setShowDeleteDialog] = React.useState(false);
  const [isDeleting, setIsDeleting] = React.useState(false);

  const handleDelete = async () => {
    setIsDeleting(true);
    try {
      await deleteProject(project.id);
      toast.success('Project deleted successfully');
      router.push('/projects');
    } catch {
      toast.error('Failed to delete project');
    } finally {
      setIsDeleting(false);
    }
  };

  const projectValue = stats.invoices.totalValue;
  const totalDue = stats.invoices.totalDue;
  const totalReceived = stats.invoices.totalPaid;
  const paymentProgress = projectValue > 0 ? (totalReceived / projectValue) * 100 : 0;

  return (
    <div className="space-y-8">
      {/* Breadcrumb */}
      <div className="text-muted-foreground flex items-center gap-1.5 text-sm">
        <Link
          href="/projects"
          className="hover:text-foreground flex items-center gap-1.5 transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Projects
        </Link>
        <span>/</span>
        <span className="text-foreground">{project.name}</span>
      </div>

      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="space-y-1">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight">{project.name}</h1>
            <Badge variant={project.isActive ? 'default' : 'secondary'} className="font-normal">
              {project.isActive ? 'Active' : 'Inactive'}
            </Badge>
          </div>
          <p className="text-muted-foreground">
            <Link
              href={`/clients/${project.client.id}`}
              className="hover:text-foreground transition-colors"
            >
              {project.client.company || project.client.name}
            </Link>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" asChild>
            <Link href={`/projects/${project.id}/edit`}>
              <Pencil className="mr-2 h-3.5 w-3.5" />
              Edit
            </Link>
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="More actions">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onClick={async () => {
                  try {
                    if (project.isActive) {
                      await deactivateProject(project.id);
                      toast.success('Project deactivated');
                    } else {
                      await reactivateProject(project.id);
                      toast.success('Project reactivated');
                    }
                    router.refresh();
                  } catch {
                    toast.error('Failed to update status');
                  }
                }}
              >
                {project.isActive ? 'Deactivate' : 'Reactivate'}
              </DropdownMenuItem>
              <DropdownMenuItem
                className="text-destructive focus:text-destructive"
                onClick={() => setShowDeleteDialog(true)}
              >
                <Trash2 className="mr-2 h-4 w-4" />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Financial Summary */}
      <div className="bg-card rounded-lg border p-6">
        <div className="grid grid-cols-3 gap-6">
          <div>
            <p className="text-muted-foreground text-sm">Project Value</p>
            <p className="mt-1 text-2xl font-semibold tracking-tight">
              {formatCurrency(projectValue, currency)}
            </p>
          </div>
          <div>
            <p className="text-muted-foreground text-sm">Outstanding</p>
            <p className="mt-1 text-2xl font-semibold tracking-tight text-amber-600">
              {formatCurrency(totalDue, currency)}
            </p>
          </div>
          <div>
            <p className="text-muted-foreground text-sm">Received</p>
            <p className="mt-1 text-2xl font-semibold tracking-tight text-emerald-600">
              {formatCurrency(totalReceived, currency)}
            </p>
          </div>
        </div>
        <div className="mt-5">
          <div className="text-muted-foreground mb-1.5 flex items-center justify-between text-xs">
            <span>Payment progress</span>
            <span>{Math.round(paymentProgress)}%</span>
          </div>
          <div className="bg-muted h-1.5 overflow-hidden rounded-full">
            <div
              className="h-full rounded-full bg-emerald-500 transition-all"
              style={{ width: `${paymentProgress}%` }}
            />
          </div>
        </div>
      </div>

      {/* Main Grid */}
      <div className="grid gap-8 lg:grid-cols-[1fr_320px]">
        {/* Main Content */}
        <div className="space-y-10">
          {/* Invoices */}
          <section>
            <SectionHeader
              title="Invoices"
              count={project.invoices.length}
              addHref={`/invoices/new?projectId=${project.id}&clientId=${project.client.id}`}
            />
            {project.invoices.length > 0 ? (
              <div className="divide-y rounded-lg border">
                {project.invoices.map((invoice) => (
                  <Link
                    key={invoice.id}
                    href={`/invoices/${invoice.id}`}
                    className="hover:bg-muted/50 flex items-center justify-between px-4 py-3 transition-colors first:rounded-t-lg last:rounded-b-lg"
                  >
                    <div>
                      <p className="text-sm font-medium">{invoice.invoiceNumber}</p>
                      <p className="text-muted-foreground mt-0.5 text-xs">
                        {invoice.title}
                        {invoice.dueDate && <> &middot; Due {formatDate(invoice.dueDate)}</>}
                      </p>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="text-sm font-medium tabular-nums">
                        {formatCurrency(
                          Number(invoice.total),
                          (invoice as any).currency || currency
                        )}
                      </span>
                      <StatusBadge status={invoice.status} />
                    </div>
                  </Link>
                ))}
              </div>
            ) : (
              <EmptyState label="No invoices yet" />
            )}
          </section>

          {/* Quotes */}
          <section>
            <SectionHeader
              title="Quotes"
              count={project.quotes.length}
              addHref={`/quotes/new?projectId=${project.id}&clientId=${project.client.id}`}
            />
            {project.quotes.length > 0 ? (
              <div className="divide-y rounded-lg border">
                {project.quotes.map((quote) => (
                  <Link
                    key={quote.id}
                    href={`/quotes/${quote.id}`}
                    className="hover:bg-muted/50 flex items-center justify-between px-4 py-3 transition-colors first:rounded-t-lg last:rounded-b-lg"
                  >
                    <div>
                      <p className="text-sm font-medium">{quote.title || quote.quoteNumber}</p>
                      <p className="text-muted-foreground mt-0.5 text-xs">
                        {quote.quoteNumber} &middot; {formatDate(quote.createdAt)}
                      </p>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="text-sm font-medium tabular-nums">
                        {formatCurrency(Number(quote.total), (quote as any).currency || currency)}
                      </span>
                      <StatusBadge status={quote.status} />
                    </div>
                  </Link>
                ))}
              </div>
            ) : (
              <EmptyState label="No quotes yet" />
            )}
          </section>

          {/* Contracts */}
          <section>
            <SectionHeader
              title="Contracts"
              count={contracts.length}
              addHref={`/contracts/new?projectId=${project.id}&clientId=${project.client.id}`}
            />
            {contracts.length > 0 ? (
              <div className="divide-y rounded-lg border">
                {contracts.map((contract) => (
                  <div
                    key={contract.id}
                    className="flex items-center justify-between px-4 py-3 first:rounded-t-lg last:rounded-b-lg"
                  >
                    <div>
                      <p className="text-sm font-medium">{contract.name}</p>
                      <p className="text-muted-foreground mt-0.5 text-xs">
                        Added {formatDate(contract.addedAt)}
                      </p>
                    </div>
                    {contract.isSigned ? (
                      <Badge
                        variant="outline"
                        className="border-emerald-200 bg-emerald-50 text-xs text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-400"
                      >
                        <CheckCircle2 className="mr-1 h-3 w-3" />
                        Signed
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="text-xs">
                        Unsigned
                      </Badge>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <EmptyState label="No contracts yet" />
            )}
          </section>

          {/* Notes */}
          <section>
            <SectionHeader title="Notes" count={notes.length} />
            {notes.length > 0 ? (
              <div className="space-y-3">
                {notes.map((note) => (
                  <div key={note.id} className="rounded-lg border px-4 py-3">
                    <p className="text-sm leading-relaxed">{note.content}</p>
                    <div className="text-muted-foreground mt-2 flex items-center gap-1.5 text-xs">
                      <span>{note.authorName}</span>
                      <span>&middot;</span>
                      <span>{formatDate(note.createdAt)}</span>
                      {note.isPrivate && (
                        <>
                          <span>&middot;</span>
                          <Lock className="h-3 w-3" />
                          <span>Private</span>
                        </>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyState label="No notes yet" />
            )}
          </section>
        </div>

        {/* Sidebar */}
        <div className="space-y-8">
          {/* Contact */}
          <section>
            <h2 className="text-muted-foreground mb-4 text-sm font-medium">Contact</h2>
            <div className="bg-card rounded-lg border p-4">
              <Link
                href={`/clients/${project.client.id}`}
                className="group flex items-center gap-3"
              >
                <div className="bg-muted flex h-10 w-10 shrink-0 items-center justify-center rounded-full">
                  {project.client.company ? (
                    <Building2 className="text-muted-foreground h-4 w-4" />
                  ) : (
                    <User className="text-muted-foreground h-4 w-4" />
                  )}
                </div>
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium group-hover:underline">
                    {project.client.name}
                  </p>
                  {project.client.company && (
                    <p className="text-muted-foreground truncate text-xs">
                      {project.client.company}
                    </p>
                  )}
                </div>
              </Link>

              <div className="mt-4 space-y-2">
                {project.client.phone && (
                  <a
                    href={`tel:${project.client.phone}`}
                    className="text-muted-foreground hover:text-foreground flex items-center gap-2 text-sm transition-colors"
                  >
                    <Phone className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate">{project.client.phone}</span>
                  </a>
                )}
                <a
                  href={`mailto:${project.client.email}`}
                  className="text-muted-foreground hover:text-foreground flex items-center gap-2 text-sm transition-colors"
                >
                  <Mail className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">{project.client.email}</span>
                </a>
              </div>

              <div className="mt-4 space-y-1 border-t pt-4">
                <button
                  className="text-muted-foreground hover:text-foreground flex w-full items-center gap-2 text-sm transition-colors"
                  onClick={() => toast.info('Client portal is not yet available')}
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  View client portal
                </button>
                <button
                  className="text-muted-foreground hover:text-foreground flex w-full items-center gap-2 text-sm transition-colors"
                  onClick={() => toast.info('Invite links are not yet available')}
                >
                  <Link2 className="h-3.5 w-3.5" />
                  Copy invite link
                </button>
                <button
                  className="text-muted-foreground hover:text-foreground flex w-full items-center gap-2 text-sm transition-colors"
                  onClick={() => toast.info('Invitations are not yet available')}
                >
                  <Send className="h-3.5 w-3.5" />
                  Send invitation
                </button>
              </div>
            </div>
          </section>

          {/* Activity */}
          <section>
            <h2 className="text-muted-foreground mb-4 text-sm font-medium">Activity</h2>
            <div className="space-y-0">
              {activity.map((item, i) => (
                <div key={item.id} className="flex gap-3">
                  <div className="relative flex flex-col items-center">
                    <div
                      className={cn(
                        'mt-1.5 h-2 w-2 shrink-0 rounded-full bg-gray-400',
                        (item.type === 'contract_signed' ||
                          item.type === 'quote_accepted' ||
                          item.type === 'invoice_paid') &&
                          'bg-emerald-500',
                        (item.type === 'quote_sent' || item.type === 'invoice_sent') &&
                          'bg-blue-500'
                      )}
                    />
                    {i < activity.length - 1 && <div className="bg-border mt-1.5 w-px flex-1" />}
                  </div>
                  <div className="pb-5">
                    <p className="text-sm">{item.title}</p>
                    <p className="text-muted-foreground mt-0.5 text-xs">
                      {formatRelativeDate(item.date)}
                      {item.amount != null && ` \u00b7 ${formatCurrency(item.amount, currency)}`}
                    </p>
                  </div>
                </div>
              ))}
              {activity.length === 0 && (
                <p className="text-muted-foreground py-2 text-sm">No activity yet</p>
              )}
            </div>
          </section>
        </div>
      </div>

      {/* Delete Dialog */}
      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete project</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete &quot;{project.name}&quot;? This action cannot be
              undone. Associated quotes, invoices, and contracts will remain but will no longer be
              linked to this project.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={isDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/* ---------- Shared sub-components ---------- */

function SectionHeader({
  title,
  count,
  addHref,
}: {
  title: string;
  count: number;
  addHref?: string;
}) {
  return (
    <div className="mb-4 flex items-center justify-between">
      <div className="flex items-center gap-2.5">
        <h2 className="text-muted-foreground text-sm font-medium">{title}</h2>
        {count > 0 && (
          <span className="text-muted-foreground bg-muted rounded-full px-2 py-0.5 text-xs tabular-nums">
            {count}
          </span>
        )}
      </div>
      {addHref && (
        <Button variant="ghost" size="sm" className="h-7 text-xs" asChild>
          <Link href={addHref}>
            <Plus className="mr-1 h-3 w-3" />
            Add
          </Link>
        </Button>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        'text-xs capitalize',
        (status === 'paid' || status === 'accepted') &&
          'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-400',
        status === 'sent' &&
          'border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-800 dark:bg-blue-950/50 dark:text-blue-400',
        status === 'draft' && 'border-border bg-muted text-muted-foreground',
        status === 'overdue' &&
          'border-red-200 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950/50 dark:text-red-400'
      )}
    >
      {status}
    </Badge>
  );
}

function EmptyState({ label }: { label: string }) {
  return <p className="text-muted-foreground py-2 text-sm">{label}</p>;
}

function formatRelativeDate(date: Date) {
  const now = new Date();
  const diff = now.getTime() - new Date(date).getTime();
  const days = Math.floor(diff / 86400000);

  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  if (days < 30) return `${Math.floor(days / 7)} weeks ago`;
  return formatDate(date);
}
