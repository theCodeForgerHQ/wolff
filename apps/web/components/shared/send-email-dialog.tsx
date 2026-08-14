'use client';

import { useState, useEffect } from 'react';
import { Loader2, Send, Plus, Trash2, X, Import } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { getEmailTemplates, getEmailTemplateById } from '@/lib/email/actions';
import { sendQuote } from '@/lib/quotes/actions';
import { sendInvoice } from '@/lib/invoices/status-actions';
import { sendContractInstance } from '@/lib/contracts/actions';

// ─── Types ────────────────────────────────────────────────
interface LineItemPreview {
  name: string;
  description?: string;
  quantity: number;
  rate: number;
  amount: number;
}

interface Recipient {
  id: string;
  name: string;
  email: string;
}

interface SendEmailDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  type: 'invoice' | 'quote' | 'contract';
  documentId: string;
  documentNumber: string;
  recipientEmail: string;
  recipientName: string;
  // Preview data
  businessName?: string;
  total?: number;
  currency?: string;
  dueDate?: string;
  lineItems?: LineItemPreview[];
  notes?: string;
  // Contract-specific
  contractName?: string;
  onSent?: () => void;
}

const ACCENT = '#3786b3';
const ACCENT_LIGHT = '#e3f2fa';

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

// ─── Main Component ───────────────────────────────────────
export function SendEmailDialog({
  open,
  onOpenChange,
  type,
  documentId,
  documentNumber,
  recipientEmail,
  recipientName,
  businessName = 'Your Business',
  total = 0,
  currency: docCurrency = 'USD',
  dueDate,
  lineItems = [],
  notes,
  contractName,
  onSent,
}: SendEmailDialogProps) {
  const label = type === 'invoice' ? 'Invoice' : type === 'quote' ? 'Quote' : 'Contract';
  const actionLabel =
    type === 'invoice' ? 'Pay this Invoice' : type === 'quote' ? 'Accept Quote' : 'Review & Sign';

  // Recipients
  const [recipients, setRecipients] = useState<Recipient[]>([
    { id: '1', name: recipientName, email: recipientEmail },
  ]);
  const [showAddRecipient, setShowAddRecipient] = useState(false);
  const [newRecipientEmail, setNewRecipientEmail] = useState('');

  // Form
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [isSending, setIsSending] = useState(false);

  // Email templates
  const [emailTemplates, setEmailTemplates] = useState<
    { id: string; name: string; subject: string }[]
  >([]);
  const [templatesLoaded, setTemplatesLoaded] = useState(false);

  useEffect(() => {
    if (open && !templatesLoaded) {
      getEmailTemplates({}).then((templates) => {
        setEmailTemplates(templates.map((t) => ({ id: t.id, name: t.name, subject: t.subject })));
        setTemplatesLoaded(true);
      });
    }
  }, [open, templatesLoaded]);

  const stripHtml = (html: string): string => {
    // First decode all HTML entities (handles double-encoded HTML)
    let text = html
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, ' ');
    // Decode again in case of double-encoding
    text = text
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, ' ');
    // Now strip all HTML tags
    text = text
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>\s*<p>/gi, '\n\n')
      .replace(
        /<\/?(p|div|h[1-6]|ul|ol|li|blockquote|section|article|header|footer|main|nav|aside|figure|figcaption|details|summary)[^>]*>/gi,
        '\n'
      )
      .replace(
        /<\/?(strong|b|em|i|u|s|strike|del|ins|sub|sup|small|mark|abbr|code|kbd|samp|var|span)[^>]*>/gi,
        ''
      )
      .replace(/<a[^>]*href="([^"]*)"[^>]*>[^<]*<\/a>/gi, '$1')
      .replace(/<[^>]+>/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return text;
  };

  const replaceVariables = (text: string): string => {
    return text
      .replace(/\{\{client_name\}\}/gi, recipientName || '')
      .replace(/\{\{clientName\}\}/gi, recipientName || '')
      .replace(/\{\{business_name\}\}/gi, businessName || '')
      .replace(/\{\{businessName\}\}/gi, businessName || '')
      .replace(/\{\{document_number\}\}/gi, documentNumber || '')
      .replace(/\{\{documentNumber\}\}/gi, documentNumber || '')
      .replace(/\{\{quote_number\}\}/gi, documentNumber || '')
      .replace(/\{\{quoteNumber\}\}/gi, documentNumber || '')
      .replace(/\{\{invoice_number\}\}/gi, documentNumber || '')
      .replace(/\{\{invoiceNumber\}\}/gi, documentNumber || '')
      .replace(
        /\{\{quote_total\}\}/gi,
        total ? formatCurrency(total, docCurrency) : formatCurrency(0, docCurrency)
      )
      .replace(
        /\{\{quoteTotal\}\}/gi,
        total ? formatCurrency(total, docCurrency) : formatCurrency(0, docCurrency)
      )
      .replace(
        /\{\{invoice_total\}\}/gi,
        total ? formatCurrency(total, docCurrency) : formatCurrency(0, docCurrency)
      )
      .replace(
        /\{\{invoiceTotal\}\}/gi,
        total ? formatCurrency(total, docCurrency) : formatCurrency(0, docCurrency)
      )
      .replace(
        /\{\{total\}\}/gi,
        total ? formatCurrency(total, docCurrency) : formatCurrency(0, docCurrency)
      )
      .replace(
        /\{\{amount\}\}/gi,
        total ? formatCurrency(total, docCurrency) : formatCurrency(0, docCurrency)
      )
      .replace(/\{\{due_date\}\}/gi, dueDate ? formatDate(dueDate) : '')
      .replace(/\{\{dueDate\}\}/gi, dueDate ? formatDate(dueDate) : '')
      .replace(/\{\{quote_valid_until\}\}/gi, dueDate ? formatDate(dueDate) : '')
      .replace(/\{\{quoteValidUntil\}\}/gi, dueDate ? formatDate(dueDate) : '')
      .replace(/\{\{contract_name\}\}/gi, contractName || '')
      .replace(/\{\{contractName\}\}/gi, contractName || '')
      .replace(/\{\{quote_name\}\}/gi, contractName || documentNumber || '')
      .replace(/\{\{quoteName\}\}/gi, contractName || documentNumber || '')
      .replace(/\{\{#if\s+\w+\}\}[\s\S]*?\{\{\/if\}\}/gi, '')
      .replace(/\{\{quote_url\}\}/gi, '[Link will be included automatically]')
      .replace(/\{\{quoteUrl\}\}/gi, '[Link will be included automatically]')
      .replace(/\{\{invoice_url\}\}/gi, '[Link will be included automatically]')
      .replace(/\{\{invoiceUrl\}\}/gi, '[Link will be included automatically]')
      .replace(/\{\{contract_url\}\}/gi, '[Link will be included automatically]')
      .replace(/\{\{contractUrl\}\}/gi, '[Link will be included automatically]')
      .replace(/\{\{message\}\}/gi, '');
  };

  const handleImportTemplate = async (templateId: string) => {
    const detail = await getEmailTemplateById(templateId);
    if (detail) {
      setSubject(replaceVariables(detail.subject));
      setMessage(replaceVariables(stripHtml(detail.body)));
      toast.success('Template imported');
    }
  };

  const effectiveSubject = subject || `${label} #${documentNumber} from ${businessName}`;
  const effectiveMessage = message || `Your message preview will appear here...`;

  const handleAddRecipient = () => {
    const email = newRecipientEmail.trim();
    if (!email) return;
    // Validate email format before adding
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) return;
    const name = email.split('@')[0] || 'Recipient';
    setRecipients((prev) => [
      ...prev,
      { id: Date.now().toString(), name, email: newRecipientEmail.trim() },
    ]);
    setNewRecipientEmail('');
    setShowAddRecipient(false);
  };

  const handleRemoveRecipient = (id: string) => {
    if (recipients.length <= 1) return;
    setRecipients((prev) => prev.filter((r) => r.id !== id));
  };

  // Bug #105: Pass custom recipients, subject, and message to server actions
  const handleSend = async () => {
    if (recipients.length === 0) {
      toast.error('Please add at least one recipient');
      return;
    }

    setIsSending(true);
    try {
      const emailOptions = {
        recipients: recipients.map((r) => r.email),
        subject: subject || undefined,
        message: message || undefined,
      };

      let result: { success: boolean; error?: string; emailSent?: boolean };

      if (type === 'quote') {
        result = await sendQuote(documentId, emailOptions);
      } else if (type === 'invoice') {
        result = await sendInvoice(documentId, emailOptions);
      } else {
        const contractResult = await sendContractInstance(documentId, emailOptions);
        result = { success: true, emailSent: contractResult.emailSent };
      }

      if (result.success) {
        if (result.emailSent) {
          toast.success(`${label} sent successfully!`);
        } else {
          toast.success(
            `${label} status updated to sent, but email delivery failed. Check email settings.`
          );
        }
        onOpenChange(false);
        onSent?.();
      } else {
        toast.error(result.error || `Failed to send ${label.toLowerCase()}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : `Failed to send ${label.toLowerCase()}`;
      toast.error(msg);
    } finally {
      setIsSending(false);
    }
  };

  const handleOpenChange = (newOpen: boolean) => {
    if (newOpen) {
      setRecipients([{ id: '1', name: recipientName, email: recipientEmail }]);
      setSubject('');
      setMessage('');
      setShowAddRecipient(false);
      setNewRecipientEmail('');
    }
    onOpenChange(newOpen);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-[1100px]! w-[95vw]! max-h-[90vh]! h-[85vh]! p-0! gap-0! flex flex-col overflow-hidden">
        {/* ─── Header ───────────────────────────────── */}
        <div className="bg-background flex shrink-0 items-center justify-between border-b px-6 py-4">
          <div>
            <DialogTitle className="text-xl font-semibold tracking-tight">Send {label}</DialogTitle>
            <DialogDescription className="text-muted-foreground mt-0.5 text-sm">
              {label} #{documentNumber}
            </DialogDescription>
          </div>
        </div>

        {/* ─── Two Panel Layout ────────────────────── */}
        <div className="grid flex-1 grid-cols-[1fr_1fr] overflow-hidden lg:grid-cols-[1fr_1.1fr]">
          {/* ═══ LEFT PANEL — Form ═══════════════════ */}
          <div className="bg-background overflow-y-auto border-r">
            <div className="space-y-6 p-6">
              {/* Recipients */}
              <div>
                <div className="mb-3 flex items-center justify-between">
                  <h3 className="text-base font-semibold">Recipients</h3>
                  <button
                    type="button"
                    className="text-primary hover:text-primary/80 flex items-center gap-1 text-sm font-medium transition-colors"
                    onClick={() => setShowAddRecipient(true)}
                  >
                    <Plus className="h-3.5 w-3.5" />
                    Add Recipient
                  </button>
                </div>

                <div className="space-y-2">
                  {recipients.map((r) => (
                    <div
                      key={r.id}
                      className="border-border/60 bg-muted/20 flex items-center justify-between rounded-lg border px-4 py-3"
                    >
                      <div className="flex min-w-0 items-center gap-3">
                        <div className="bg-primary/10 text-primary flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-medium">
                          {r.name
                            .split(' ')
                            .map((n) => n[0])
                            .join('')
                            .toUpperCase()
                            .slice(0, 2)}
                        </div>
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">{r.name}</p>
                          <p className="text-muted-foreground truncate text-xs">{r.email}</p>
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        {recipients.length > 1 && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="text-muted-foreground hover:text-destructive h-7 w-7"
                            onClick={() => handleRemoveRecipient(r.id)}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        )}
                      </div>
                    </div>
                  ))}

                  {/* Add recipient inline form */}
                  {showAddRecipient && (
                    <div className="flex items-center gap-2">
                      <Input
                        type="email"
                        placeholder="email@example.com"
                        value={newRecipientEmail}
                        onChange={(e) => setNewRecipientEmail(e.target.value)}
                        className="h-10 flex-1"
                        onKeyDown={(e) => e.key === 'Enter' && handleAddRecipient()}
                        autoFocus
                      />
                      <Button
                        size="sm"
                        onClick={handleAddRecipient}
                        disabled={!newRecipientEmail.trim()}
                      >
                        Add
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setShowAddRecipient(false);
                          setNewRecipientEmail('');
                        }}
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                  )}
                </div>
              </div>

              <Separator />

              {/* Subject */}
              <div>
                <h3 className="mb-2 text-base font-semibold">Subject</h3>
                <Input
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  placeholder={`${label} #${documentNumber} from ${businessName}`}
                  className="h-10"
                />
              </div>

              <Separator />

              {/* Body */}
              <div>
                <div className="mb-2 flex items-center justify-between">
                  <h3 className="text-base font-semibold">Body</h3>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="outline" size="icon" className="h-8 w-8 shadow-none">
                        <Import className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-64">
                      <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">
                        Select a template to import
                      </DropdownMenuLabel>
                      <DropdownMenuSeparator />
                      {emailTemplates.length === 0 ? (
                        <div className="text-muted-foreground px-2 py-3 text-center text-xs">
                          No templates available
                        </div>
                      ) : (
                        emailTemplates.map((tmpl) => (
                          <DropdownMenuItem
                            key={tmpl.id}
                            onClick={() => handleImportTemplate(tmpl.id)}
                            className="flex cursor-pointer flex-col items-start gap-0.5"
                          >
                            <span className="text-sm font-medium">{tmpl.name}</span>
                            <span className="text-muted-foreground w-full truncate text-xs">
                              {tmpl.subject}
                            </span>
                          </DropdownMenuItem>
                        ))
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
                <div className="overflow-hidden rounded-lg border">
                  <textarea
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    placeholder="Enter a message..."
                    className="focus:outline-hidden bg-background min-h-[200px] w-full resize-none p-4 text-sm"
                  />
                </div>
              </div>

              {/* Send Button */}
              <div className="pt-2">
                <Button
                  onClick={handleSend}
                  disabled={isSending}
                  size="lg"
                  className="bg-primary hover:bg-primary/90 px-8 text-white"
                >
                  {isSending ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Send className="mr-2 h-4 w-4" />
                  )}
                  Send Email
                </Button>
              </div>
            </div>
          </div>

          {/* ═══ RIGHT PANEL — Email Preview ═════════ */}
          <div className="bg-muted/30 overflow-y-auto">
            <div className="p-4 lg:p-6">
              {/* Subject preview */}
              <div className="bg-muted/50 border-border/40 mb-4 rounded-lg border px-4 py-3">
                <p className="text-muted-foreground text-sm">
                  {subject ? (
                    subject
                  ) : (
                    <span className="italic">Your subject preview will appear here...</span>
                  )}
                </p>
              </div>

              {/* Email card */}
              <div className="bg-card overflow-hidden rounded-xl border shadow-sm">
                {/* Branded header with gradient */}
                <div
                  className="relative h-28 overflow-hidden"
                  style={{
                    background: `linear-gradient(135deg, ${ACCENT}22 0%, ${ACCENT}44 40%, ${ACCENT}66 60%, ${ACCENT}33 100%)`,
                  }}
                >
                  {/* Decorative circles */}
                  <div
                    className="absolute -right-10 -top-10 h-40 w-40 rounded-full opacity-20"
                    style={{ background: ACCENT }}
                  />
                  <div
                    className="absolute -bottom-6 right-20 h-24 w-24 rounded-full opacity-15"
                    style={{ background: ACCENT }}
                  />
                  <div
                    className="absolute bottom-6 left-6 h-12 w-12 rounded-full opacity-10"
                    style={{ background: '#fff' }}
                  />
                </div>

                {/* Business name + Label */}
                <div className="px-6 pb-4 pt-5">
                  <div className="flex items-start justify-between">
                    <div>
                      <h3 className="text-lg font-bold tracking-tight">{businessName}</h3>
                    </div>
                    <div className="text-right">
                      <p className="text-muted-foreground text-xs">{businessName}</p>
                      <p className="mt-0.5 text-lg font-bold" style={{ color: ACCENT }}>
                        {label}
                      </p>
                    </div>
                  </div>
                </div>

                {/* Message preview */}
                <div className="px-6 pb-4">
                  {/* CR #24: Split once, not twice per render */}
                  <p className="text-muted-foreground text-sm leading-relaxed">
                    {message ? (
                      (() => {
                        const lines = message.split('\n');
                        return lines.map((line, i) => (
                          <span key={i}>
                            {line}
                            {i < lines.length - 1 && <br />}
                          </span>
                        ));
                      })()
                    ) : (
                      <span className="italic">Your message preview will appear here...</span>
                    )}
                  </p>
                </div>

                {/* CTA Buttons */}
                <div className="flex gap-3 px-6 pb-4">
                  <button
                    className="flex h-11 flex-1 items-center justify-center gap-2 rounded-lg text-sm font-medium text-white transition-colors"
                    style={{ backgroundColor: ACCENT }}
                  >
                    {actionLabel}
                  </button>
                  <button className="border-border hover:bg-muted flex h-11 flex-1 items-center justify-center gap-2 rounded-lg border text-sm font-medium transition-colors">
                    Download PDF
                  </button>
                </div>

                <Separator />

                {/* Document Summary */}
                <div className="space-y-3 px-6 py-4">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-semibold">
                      {type === 'contract'
                        ? contractName || `Contract #${documentNumber}`
                        : type === 'invoice'
                          ? `Invoice #${documentNumber}`
                          : `Quote #${documentNumber}`}
                    </p>
                    {dueDate && (
                      <p className="text-muted-foreground text-xs">
                        {type === 'invoice' ? 'Due' : type === 'quote' ? 'Valid until' : 'Sent on'}{' '}
                        {formatDate(dueDate)}
                      </p>
                    )}
                  </div>

                  {/* Line Items (invoices/quotes only) */}
                  {type !== 'contract' && lineItems.length > 0 && (
                    <div className="space-y-1">
                      {lineItems.map((item, i) => (
                        <div key={i} className="flex items-center justify-between py-1.5 text-sm">
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium">
                              {item.name || 'Untitled Item'}
                            </p>
                            <p className="text-muted-foreground truncate text-xs">
                              {item.quantity} &times; {formatCurrency(item.rate, docCurrency)}
                              {item.description && (
                                <span className="text-muted-foreground ml-1.5">
                                  &middot; {item.description}
                                </span>
                              )}
                            </p>
                          </div>
                          <span className="ml-4 text-sm font-medium tabular-nums">
                            {formatCurrency(item.amount, docCurrency)}
                          </span>
                        </div>
                      ))}
                      <Separator className="my-2" />
                    </div>
                  )}

                  {/* Total (invoices/quotes only) */}
                  {type !== 'contract' && (
                    <div className="flex justify-between text-sm font-semibold">
                      <span>{type === 'invoice' ? 'Total Due' : 'Total'}</span>
                      <span className="tabular-nums" style={{ color: ACCENT }}>
                        {formatCurrency(total, docCurrency)}
                      </span>
                    </div>
                  )}

                  {/* Contract description */}
                  {type === 'contract' && (
                    <p className="text-muted-foreground text-sm">
                      Please review and sign this contract at your earliest convenience.
                    </p>
                  )}
                </div>

                {/* Notes */}
                {notes && (
                  <>
                    <Separator />
                    <div className="px-6 py-4">
                      <p className="text-muted-foreground text-sm italic">{notes}</p>
                    </div>
                  </>
                )}

                {/* Legal Footer */}
                <div className="bg-muted/30 border-t px-6 py-4">
                  <p className="text-muted-foreground text-[10px] leading-relaxed">
                    This email was sent by {businessName} via Wolff. If you have questions about
                    this {type}, please contact {businessName} directly.
                  </p>
                  <div className="mt-3 flex items-center justify-center gap-2">
                    <div className="bg-border/40 h-px flex-1" />
                    <p className="text-muted-foreground whitespace-nowrap text-[10px]">
                      Powered by Wolff
                    </p>
                    <div className="bg-border/40 h-px flex-1" />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
