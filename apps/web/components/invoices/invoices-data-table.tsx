'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Receipt, Plus, Download, Pencil, Check, ChevronUp } from 'lucide-react';
import { DataTable } from '@/components/ui/data-table/data-table';
import { getInvoiceColumns, invoiceStatusOptions } from './invoices-columns';
import { InvoiceListItem } from '@/lib/invoices/types';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import Link from 'next/link';
import { deleteInvoice, duplicateInvoice } from '@/lib/invoices/actions';
import { getInvoice } from '@/lib/invoices/queries';
import { getBusinessProfile } from '@/lib/settings/actions';
import { cn } from '@/lib/utils';
import { SendEmailDialog } from '@/components/shared/send-email-dialog';
import { RecordPaymentDialog } from './record-payment-dialog';
import { RecurringSettingsDialog, RecurringSettings } from './recurring-settings-dialog';

const ACCENT = '#3786b3';
const ACCENT_LIGHT = '#e3f2fa';
const ACCENT_BG = 'bg-sky-50/60';

// Bug #172: Accept currency parameter instead of hardcoding USD
function formatCurrency(amount: number, currency: string = 'USD'): string {
  const parts = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
  }).formatToParts(amount);
  return parts
    .map((p, i) => {
      if (p.type === 'currency' && parts[i + 1]?.type !== 'literal') return p.value + ' ';
      return p.value;
    })
    .join('');
}

function formatDate(dateString: string): string {
  return new Date(dateString).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

interface InvoicesDataTableProps {
  data: InvoiceListItem[];
  /** IDs of invoices that have recurring enabled, passed from server */
  recurringInvoiceIds?: string[];
}

export function InvoicesDataTable({
  data: initialData,
  recurringInvoiceIds: serverRecurringIds,
}: InvoicesDataTableProps) {
  const router = useRouter();
  const [isProcessing, setIsProcessing] = useState(false);
  const [viewingInvoice, setViewingInvoice] = useState<any | null>(null);
  const [showDetails, setShowDetails] = useState(true);

  // Local data state for status/payment updates
  const [data, setData] = useState(initialData);

  // Business name for email dialog
  const [businessName, setBusinessName] = useState('');
  useEffect(() => {
    getBusinessProfile()
      .then((p) => setBusinessName(p?.businessName || ''))
      .catch(() => {});
  }, []);

  // Dialog states
  const [sendDialogOpen, setSendDialogOpen] = useState(false);
  const [sendTarget, setSendTarget] = useState<InvoiceListItem | null>(null);
  const [paymentDialogOpen, setPaymentDialogOpen] = useState(false);
  const [paymentTarget, setPaymentTarget] = useState<InvoiceListItem | null>(null);
  const [recurringDialogOpen, setRecurringDialogOpen] = useState(false);
  const [recurringTarget, setRecurringTarget] = useState<InvoiceListItem | null>(null);

  // Payment history for viewing invoice
  const [viewPayments, setViewPayments] = useState<any[]>([]);

  // Recurring invoice IDs — populated from server data
  const [recurringIds, setRecurringIds] = useState<Set<string>>(new Set(serverRecurringIds || []));

  const handleView = async (invoice: InvoiceListItem) => {
    try {
      const fullInvoice = await getInvoice(invoice.id);
      if (fullInvoice) {
        setViewingInvoice(fullInvoice);
        setViewPayments((fullInvoice as any).payments || []);
        setShowDetails(true);
      } else {
        // Fallback: navigate to detail page
        router.push(`/invoices/${invoice.id}`);
      }
    } catch {
      router.push(`/invoices/${invoice.id}`);
    }
  };

  const handleCloseView = () => {
    setViewingInvoice(null);
    setViewPayments([]);
  };

  const handleDelete = async (invoice: InvoiceListItem) => {
    if (isProcessing) return;
    setIsProcessing(true);
    try {
      const result = await deleteInvoice(invoice.id);
      if (result.success) {
        toast.success('Invoice deleted successfully');
        setData((prev) => prev.filter((i) => i.id !== invoice.id));
      } else {
        toast.error(result.error || 'Failed to delete invoice');
      }
    } catch {
      toast.error('Failed to delete invoice');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleDuplicate = async (invoice: InvoiceListItem) => {
    if (isProcessing) return;
    setIsProcessing(true);
    try {
      const result = await duplicateInvoice(invoice.id);
      if (result.success && result.invoiceId) {
        toast.success('Invoice duplicated successfully');
        router.push(`/invoices/${result.invoiceId}`);
      } else {
        toast.error(result.error || 'Failed to duplicate invoice');
      }
    } catch {
      toast.error('Failed to duplicate invoice');
    } finally {
      setIsProcessing(false);
    }
  };

  // Send Invoice
  const handleSend = useCallback((invoice: InvoiceListItem) => {
    setSendTarget(invoice);
    setSendDialogOpen(true);
  }, []);

  const handleSendComplete = useCallback(() => {
    if (sendTarget) {
      setData((prev) =>
        prev.map((inv) => (inv.id === sendTarget.id ? { ...inv, status: 'sent' as const } : inv))
      );
    }
    setSendTarget(null);
  }, [sendTarget]);

  // Copy Link
  const handleCopyLink = useCallback(async (invoice: InvoiceListItem) => {
    if (!invoice.accessToken) {
      toast.error('No portal link available — send the invoice first');
      return;
    }
    const url = `${window.location.origin}/i/${invoice.accessToken}`;
    try {
      await navigator.clipboard.writeText(url);
      toast.success('Link copied to clipboard');
    } catch {
      toast.error('Failed to copy link');
    }
  }, []);

  // Record Payment
  const handleRecordPayment = useCallback((invoice: InvoiceListItem) => {
    setPaymentTarget(invoice);
    setPaymentDialogOpen(true);
  }, []);

  const handlePaymentRecorded = useCallback(() => {
    // Refresh data from server after payment recorded
    setPaymentTarget(null);
    router.refresh();
  }, [router]);

  // Recurring Settings
  const handleRecurringSettings = useCallback((invoice: InvoiceListItem) => {
    setRecurringTarget(invoice);
    setRecurringDialogOpen(true);
  }, []);

  const handleRecurringSaved = useCallback(
    (settings: RecurringSettings) => {
      if (recurringTarget) {
        setRecurringIds((prev) => {
          const next = new Set(prev);
          if (settings.enabled) {
            next.add(recurringTarget.id);
          } else {
            next.delete(recurringTarget.id);
          }
          return next;
        });
      }
      setRecurringTarget(null);
    },
    [recurringTarget]
  );

  const columns = getInvoiceColumns({
    onView: handleView,
    onEdit: (invoice) => {
      router.push(`/invoices/${invoice.id}/edit`);
    },
    onDelete: handleDelete,
    onDuplicate: handleDuplicate,
    onDownload: (invoice) => {
      window.open(`/api/download/invoice/${invoice.id}`, '_blank');
    },
    onSend: handleSend,
    onCopyLink: handleCopyLink,
    onRecordPayment: handleRecordPayment,
    onRecurringSettings: handleRecurringSettings,
    recurringInvoiceIds: recurringIds,
  });

  const emptyState = (
    <div className="flex flex-col items-center justify-center py-16">
      <Receipt className="text-muted-foreground mb-4 h-12 w-12" />
      <h3 className="text-lg font-medium">No invoices yet</h3>
      <p className="text-muted-foreground mb-4">
        Create your first invoice or convert a quote to an invoice
      </p>
      <div className="flex gap-3">
        <Button asChild>
          <Link href="/invoices/new">
            <Plus className="mr-2 h-4 w-4" />
            Create Invoice
          </Link>
        </Button>
        <Button variant="outline" asChild>
          <Link href="/quotes">View Quotes</Link>
        </Button>
      </div>
    </div>
  );

  const invoice = viewingInvoice;

  return (
    <>
      <DataTable
        columns={columns}
        data={data}
        filterKey="client"
        filterPlaceholder="Search invoices..."
        statusOptions={invoiceStatusOptions}
        statusFilterKey="status"
        pageSizes={[10, 25, 50, 100]}
        emptyState={emptyState}
        onRowClick={(invoice) => handleView(invoice)}
      />

      {/* Invoice View Dialog -- Payment Page Style */}
      <Dialog open={!!viewingInvoice} onOpenChange={(open) => !open && handleCloseView()}>
        <DialogContent className="flex! flex-col! max-w-[520px]! max-h-[90vh]! p-0! gap-0! overflow-hidden">
          <DialogTitle className="sr-only">Invoice Preview</DialogTitle>
          {invoice && (
            <>
              {/* Scrollable content */}
              <div className="flex-1 overflow-y-auto">
                {/* Payment Page Card */}
                <div className="bg-card relative overflow-hidden">
                  {/* Subtle wave decoration */}
                  <svg
                    className="pointer-events-none absolute left-0 top-0"
                    viewBox="0 0 200 120"
                    fill="none"
                    style={{ width: '45%', height: '100px' }}
                  >
                    <path
                      d="M0 0 L0 80 Q60 72 120 40 Q160 18 200 0 Z"
                      fill={ACCENT}
                      opacity="0.05"
                    />
                    <path
                      d="M0 0 L0 50 Q40 44 80 24 Q110 10 140 0 Z"
                      fill={ACCENT}
                      opacity="0.03"
                    />
                  </svg>

                  {/* Header -- centered */}
                  <div className="relative px-6 pb-5 pt-8 text-center">
                    <div
                      className="mb-3 inline-flex h-10 w-10 items-center justify-center rounded-full"
                      style={{ backgroundColor: ACCENT_LIGHT }}
                    >
                      <Check className="h-5 w-5" style={{ color: ACCENT }} />
                    </div>
                    <h3 className="text-base font-semibold tracking-tight">
                      {invoice.client?.name || 'Invoice'}
                    </h3>
                    <p className="mt-1 text-3xl font-bold tracking-tight" style={{ color: ACCENT }}>
                      {formatCurrency(invoice.totals.total, invoice.currency)}
                    </p>
                    <p className="text-muted-foreground mt-1 text-xs">
                      Invoice #{invoice.invoiceNumber} &middot; Due {formatDate(invoice.dueDate)}
                    </p>
                  </div>

                  <Separator className="border-gray-100" />

                  {/* Transaction History */}
                  {viewPayments.length > 0 && (
                    <>
                      <div className="px-6 py-4">
                        <p className="text-muted-foreground mb-3 text-xs font-medium">
                          Payment History
                        </p>
                        <div className="space-y-2">
                          {viewPayments.map((pmt: any) => (
                            <div
                              key={pmt.id}
                              className="flex items-center justify-between border-b border-gray-50 py-2 text-sm last:border-0"
                            >
                              <div>
                                <p className="text-sm font-medium">
                                  {pmt.paymentMethod || 'Payment'}
                                </p>
                                <p className="text-muted-foreground text-xs">
                                  {formatDate(pmt.paymentDate || pmt.createdAt)}
                                  {pmt.referenceNumber && ` · ${pmt.referenceNumber}`}
                                </p>
                              </div>
                              <span className="text-sm font-medium tabular-nums text-green-600">
                                +{formatCurrency(pmt.amount, invoice.currency)}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                      <Separator className="border-gray-100" />
                    </>
                  )}

                  {/* Client + Line Items (Collapsible) */}
                  <div className="px-6 py-4">
                    <Collapsible open={showDetails} onOpenChange={setShowDetails}>
                      <div className="mb-3 flex items-center justify-between">
                        <div>
                          <p className="text-sm font-semibold">
                            {invoice.client?.name || 'Select a customer'}
                          </p>
                          {invoice.client?.company &&
                            invoice.client.company !== invoice.client.name && (
                              <p className="text-muted-foreground text-xs">
                                {invoice.client.company}
                              </p>
                            )}
                        </div>
                        <CollapsibleTrigger asChild>
                          <button className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-xs transition-colors">
                            {showDetails ? 'Hide' : 'Details'}
                            <ChevronUp
                              className={cn(
                                'h-3 w-3 transition-transform',
                                !showDetails && 'rotate-180'
                              )}
                            />
                          </button>
                        </CollapsibleTrigger>
                      </div>

                      <CollapsibleContent>
                        <Separator className="mb-4 border-gray-100" />
                        <div className="space-y-2">
                          {invoice.lineItems.map((item: any) => (
                            <div
                              key={item.id}
                              className="flex items-center justify-between py-2 text-sm"
                            >
                              <div className="min-w-0 flex-1">
                                <p className="truncate text-sm font-medium">
                                  {item.name || 'Untitled Item'}
                                </p>
                                <p className="text-muted-foreground mt-0.5 truncate text-xs">
                                  {item.quantity} &times;{' '}
                                  {formatCurrency(item.rate, invoice.currency)}
                                  {item.description && (
                                    <span className="text-muted-foreground ml-1.5">
                                      &middot; {item.description}
                                    </span>
                                  )}
                                </p>
                              </div>
                              <span className="ml-4 text-sm font-medium tabular-nums">
                                {formatCurrency(item.amount, invoice.currency)}
                              </span>
                            </div>
                          ))}

                          <Separator className="my-4 border-gray-100" />

                          {/* Subtotal/Discount rows if applicable */}
                          {invoice.totals.discountAmount > 0 && (
                            <div className="mb-3 space-y-2">
                              <div className="flex justify-between text-sm">
                                <span className="text-muted-foreground">Subtotal</span>
                                <span className="tabular-nums">
                                  {formatCurrency(invoice.totals.subtotal, invoice.currency)}
                                </span>
                              </div>
                              <div className="flex justify-between text-sm">
                                <span className="text-muted-foreground">Discount</span>
                                <span className="tabular-nums text-green-600">
                                  -{formatCurrency(invoice.totals.discountAmount, invoice.currency)}
                                </span>
                              </div>
                            </div>
                          )}

                          {/* Amount Paid row if applicable */}
                          {invoice.totals.amountPaid > 0 && (
                            <div className="mb-3 space-y-2">
                              {invoice.totals.discountAmount === 0 && (
                                <div className="flex justify-between text-sm">
                                  <span className="text-muted-foreground">Subtotal</span>
                                  <span className="tabular-nums">
                                    {formatCurrency(invoice.totals.subtotal, invoice.currency)}
                                  </span>
                                </div>
                              )}
                              <div className="flex justify-between text-sm">
                                <span className="text-muted-foreground">Paid</span>
                                <span className="tabular-nums text-green-600">
                                  -{formatCurrency(invoice.totals.amountPaid, invoice.currency)}
                                </span>
                              </div>
                            </div>
                          )}

                          {/* Total Due row */}
                          <div
                            className={cn(
                              '-mx-3 flex items-baseline justify-between rounded-lg border-l-2 px-3 py-3',
                              ACCENT_BG
                            )}
                            style={{ borderLeftColor: ACCENT }}
                          >
                            <span className="text-sm font-semibold">Total Due</span>
                            <span
                              className="text-lg font-bold tabular-nums"
                              style={{ color: ACCENT }}
                            >
                              {formatCurrency(invoice.totals.amountDue, invoice.currency)}
                            </span>
                          </div>
                        </div>
                      </CollapsibleContent>
                    </Collapsible>
                  </div>

                  {/* Notes */}
                  {invoice.notes && (
                    <>
                      <Separator className="border-gray-100" />
                      <div className="px-6 py-5">
                        <p className="text-muted-foreground text-sm">{invoice.notes}</p>
                      </div>
                    </>
                  )}

                  {/* Download Button */}
                  <div className="px-6 pb-6 pt-2">
                    <button
                      onClick={() => window.open(`/api/download/invoice/${invoice.id}`, '_blank')}
                      className="flex h-12 w-full items-center justify-center gap-2 rounded-lg text-sm font-medium text-white transition-colors"
                      style={{ backgroundColor: ACCENT }}
                    >
                      <Download className="h-4 w-4" />
                      Download Invoice
                    </button>
                  </div>

                  {/* Powered By Footer */}
                  <div className="px-6 pb-5">
                    <div className="flex items-center justify-center gap-2">
                      <div className="bg-border/40 h-px flex-1" />
                      <p className="text-muted-foreground whitespace-nowrap text-[10px]">
                        Powered by Wolff
                      </p>
                      <div className="bg-border/40 h-px flex-1" />
                    </div>
                  </div>
                </div>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Send Email Dialog */}
      {sendTarget &&
        (() => {
          return (
            <SendEmailDialog
              open={sendDialogOpen}
              onOpenChange={setSendDialogOpen}
              type="invoice"
              documentId={sendTarget.id}
              documentNumber={sendTarget.invoiceNumber}
              recipientEmail={sendTarget.client.email || ''}
              recipientName={sendTarget.client.name}
              businessName={businessName}
              total={sendTarget.total}
              currency={sendTarget.currency}
              dueDate={sendTarget.dueDate}
              onSent={handleSendComplete}
            />
          );
        })()}

      {/* Record Payment Dialog */}
      {paymentTarget && (
        <RecordPaymentDialog
          invoiceId={paymentTarget.id}
          amountDue={
            data.find((i) => i.id === paymentTarget.id)?.amountDue ?? paymentTarget.amountDue
          }
          // Low #173: Use invoice's actual currency instead of hardcoded USD
          currency={data.find((i) => i.id === paymentTarget.id)?.currency}
          open={paymentDialogOpen}
          onOpenChange={setPaymentDialogOpen}
          onPaymentRecorded={handlePaymentRecorded}
        />
      )}

      {/* Recurring Settings Dialog */}
      {recurringTarget && (
        <RecurringSettingsDialog
          invoiceId={recurringTarget.id}
          open={recurringDialogOpen}
          onOpenChange={setRecurringDialogOpen}
          onSave={handleRecurringSaved}
        />
      )}
    </>
  );
}
