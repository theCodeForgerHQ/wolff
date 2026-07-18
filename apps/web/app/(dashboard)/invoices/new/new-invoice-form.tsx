'use client';

import { useState, useMemo, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { getSavedLineItems, type SavedLineItemData } from '@/lib/saved-items/actions';
import {
  CalendarIcon,
  Plus,
  Trash2,
  Loader2,
  CreditCard,
  Mail,
  FileText,
  ChevronDown,
  ChevronUp,
  Pencil,
  Download,
  Palette,
  Building2,
  FileText as FileTextIcon,
  Paperclip,
  Link2,
  CalendarPlus,
  RotateCcw,
  Banknote,
  Hash,
  HelpCircle,
  Check,
  Camera,
  Briefcase,
  Megaphone,
  PartyPopper,
} from 'lucide-react';
import { format } from 'date-fns';

import { DownloadUnavailable } from '@/components/pdf/download-unavailable';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { Separator } from '@/components/ui/separator';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Label } from '@/components/ui/label';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Switch } from '@/components/ui/switch';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command';
import { toast } from 'sonner';
import { createInvoice, sendInvoice, getInvoiceTemplates } from '@/lib/invoices/actions';
import type { InvoiceTemplateLineItem } from '@/lib/invoices/actions';

// ─── Types ───────────────────────────────────────────────
interface LineItem {
  id: string;
  name: string;
  description: string;
  quantity: number;
  rate: number;
}

type PreviewTab = 'payment' | 'email' | 'pdf';

// ─── Invoice Templates ───────────────────────────────────
// Each template defines a completely different visual design approach
interface InvoiceTemplate {
  label: string;
  // Design style determines the entire layout approach
  style: 'clean' | 'stripe' | 'minimal' | 'accent-bar' | 'glassmorphism' | 'receipt';
  // Colors
  accent: string; // accent color for totals, balance due
  accentBg: string; // accent background for highlight areas
  accentLight: string; // lighter accent for borders/subtle elements
  separatorClass: string; // Separator override class
  cardClass: string; // outer card class
  amountSize: string; // tw class for the $ amount
  buttonColor: string; // download button color
  // Style-specific
  topBorder?: string; // top border color/gradient for accent-bar style
  bgTint?: string; // subtle background tint
}

const INVOICE_TEMPLATES: Record<string, InvoiceTemplate> = {
  clean: {
    label: 'Clean',
    style: 'clean',
    accent: '#6d28d9',
    accentBg: 'bg-violet-50/60',
    accentLight: '#ede9fe',
    separatorClass: 'border-gray-100',
    cardClass: 'rounded-2xl',
    amountSize: 'text-2xl',
    buttonColor: 'bg-violet-600 hover:bg-violet-700 text-white',
  },
  stripe: {
    label: 'Stripe',
    style: 'stripe',
    accent: '#635bff',
    accentBg: 'bg-indigo-50/60',
    accentLight: '#e0e7ff',
    separatorClass: 'border-gray-100',
    cardClass: 'rounded-xl',
    amountSize: 'text-3xl',
    buttonColor: 'bg-indigo-600 hover:bg-indigo-700 text-white',
  },
  minimal: {
    label: 'Minimal',
    style: 'minimal',
    accent: '#18181b',
    accentBg: 'bg-zinc-50/80',
    accentLight: '#f4f4f5',
    separatorClass: 'border-zinc-100',
    cardClass: 'rounded-lg',
    amountSize: 'text-3xl',
    buttonColor: 'bg-zinc-900 hover:bg-zinc-800 text-white',
  },
  ocean: {
    label: 'Ocean',
    style: 'accent-bar',
    accent: '#0d9488',
    accentBg: 'bg-teal-50/60',
    accentLight: '#ccfbf1',
    separatorClass: 'border-teal-50',
    cardClass: 'rounded-xl',
    amountSize: 'text-2xl',
    buttonColor: 'bg-teal-600 hover:bg-teal-700 text-white',
    topBorder: 'linear-gradient(90deg, #14b8a6, #0d9488, #0f766e)',
  },
  glass: {
    label: 'Glass',
    style: 'glassmorphism',
    accent: '#7c3aed',
    accentBg: 'bg-purple-50/40',
    accentLight: '#f3e8ff',
    separatorClass: 'border-purple-100/50',
    cardClass: 'rounded-2xl',
    amountSize: 'text-2xl',
    buttonColor: 'bg-purple-600 hover:bg-purple-700 text-white',
    bgTint: 'linear-gradient(135deg, #faf5ff 0%, #f0f9ff 50%, #fdf4ff 100%)',
  },
  receipt: {
    label: 'Receipt',
    style: 'receipt',
    accent: '#059669',
    accentBg: 'bg-emerald-50/60',
    accentLight: '#d1fae5',
    separatorClass: 'border-dashed border-gray-200',
    cardClass: 'rounded-lg',
    amountSize: 'text-3xl',
    buttonColor: 'bg-emerald-600 hover:bg-emerald-700 text-white',
  },
  sunset: {
    label: 'Sunset',
    style: 'accent-bar',
    accent: '#ea580c',
    accentBg: 'bg-orange-50/60',
    accentLight: '#ffedd5',
    separatorClass: 'border-orange-100',
    cardClass: 'rounded-xl',
    amountSize: 'text-2xl',
    buttonColor: 'bg-orange-600 hover:bg-orange-700 text-white',
    topBorder: 'linear-gradient(90deg, #f97316, #ea580c, #dc2626)',
  },
  corporate: {
    label: 'Corporate',
    style: 'stripe',
    accent: '#1e40af',
    accentBg: 'bg-blue-50/60',
    accentLight: '#dbeafe',
    separatorClass: 'border-blue-50',
    cardClass: 'rounded-lg',
    amountSize: 'text-2xl',
    buttonColor: 'bg-blue-700 hover:bg-blue-800 text-white',
  },
  wolff: {
    label: 'Wolff',
    style: 'clean',
    accent: '#3786b3',
    accentBg: 'bg-primary-50/60',
    accentLight: '#e3f2fa',
    separatorClass: 'border-primary-100',
    cardClass: 'rounded-2xl',
    amountSize: 'text-3xl',
    buttonColor: 'bg-primary-600 hover:bg-primary-700 text-white',
  },
};

type TemplateName = keyof typeof INVOICE_TEMPLATES;

// ─── Section Header Component ────────────────────────────
function SectionHeader({
  title,
  action,
  actionLabel,
  onAction,
}: {
  title: string;
  action?: boolean;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div className="mb-4 flex items-center justify-between">
      <h3 className="text-lg font-semibold tracking-tight">{title}</h3>
      {action && (
        <button
          onClick={onAction}
          className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-sm transition-colors"
        >
          {actionLabel}
          <ChevronDown className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

// ─── Props (from server component) ──────────────────────
interface ClientOption {
  id: string;
  name: string;
  email: string | null;
  company: string | null;
}

interface TaxRateOption {
  id: string;
  name: string;
  rate: number;
  isDefault: boolean;
  isActive: boolean;
}

interface NewInvoiceFormProps {
  clients: ClientOption[];
  taxRates?: TaxRateOption[];
  currency?: string;
  nextInvoiceNumber: string;
  businessName?: string;
}

function formatMoney(amount: number, currency: string): string {
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

// ─── Main Component ──────────────────────────────────────
export function NewInvoiceForm({
  clients,
  taxRates = [],
  currency = 'USD',
  nextInvoiceNumber,
  businessName = 'Your Business',
}: NewInvoiceFormProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [loading, setLoading] = useState(false);
  const [fromQuoteNumber, setFromQuoteNumber] = useState<string | null>(null);
  const [selectedCurrency, setSelectedCurrency] = useState(currency);

  // Form State
  const [invoiceNumber, setInvoiceNumber] = useState(nextInvoiceNumber);
  const [dueDate, setDueDate] = useState<Date | undefined>(
    new Date(Date.now() + 14 * 24 * 60 * 60 * 1000)
  );
  const [selectedClientId, setSelectedClientId] = useState<string>('');
  const [lineItems, setLineItems] = useState<LineItem[]>([]);
  const defaultTaxRate = taxRates.find((t) => t.isDefault && t.isActive);
  const [taxRate, setTaxRate] = useState(
    defaultTaxRate ? `${defaultTaxRate.rate}%` : '0% - Default'
  );
  const [customTaxRate, setCustomTaxRate] = useState('');
  const [notes, setNotes] = useState('Thank you for your business!');
  const [discount, setDiscount] = useState(0);
  const [discountType, setDiscountType] = useState<'flat' | 'percent'>('flat');

  // Invoice Details Options
  const [showBillAsCompany, setShowBillAsCompany] = useState(false);
  const [companyName, setCompanyName] = useState('');
  const [showIssueDate, setShowIssueDate] = useState(true);
  const [issueDate, setIssueDate] = useState<Date | undefined>(new Date());
  const [showPoNumber, setShowPoNumber] = useState(false);
  const [poNumber, setPoNumber] = useState('');
  const [showCustomField, setShowCustomField] = useState(false);
  const [customFieldLabel, setCustomFieldLabel] = useState('');
  const [customFieldValue, setCustomFieldValue] = useState('');

  // Add Enhancements
  const [showDescription, setShowDescription] = useState(false);
  const [description, setDescription] = useState('');
  const [showAttachments, setShowAttachments] = useState(false);
  const [showEvent, setShowEvent] = useState(false);
  const [eventName, setEventName] = useState('');
  const [eventDate, setEventDate] = useState<Date | undefined>(undefined);

  // Payment Settings
  const [showDeposit, setShowDeposit] = useState(false);
  const [depositAmount, setDepositAmount] = useState(0);
  const [showDiscount, setShowDiscount] = useState(false);
  const [allowTipping, setAllowTipping] = useState(false);
  const [showRecurring, setShowRecurring] = useState(false);
  const [recurringInterval, setRecurringInterval] = useState('monthly');
  const [showCustomLinks, setShowCustomLinks] = useState(false);
  const [customLinkUrl, setCustomLinkUrl] = useState('');
  const [customLinkLabel, setCustomLinkLabel] = useState('');
  const [pdfPaymentLink, setPdfPaymentLink] = useState(true);

  // UI State
  const [previewTab, setPreviewTab] = useState<PreviewTab>('payment');
  const [showPreviewDetails, setShowPreviewDetails] = useState(true);
  const [templateName, setTemplateName] = useState<TemplateName>('wolff');

  // Refs

  // Pre-fill from quote conversion
  useEffect(() => {
    const fromQuoteId = searchParams.get('fromQuote');
    if (!fromQuoteId) return;

    try {
      const stored = localStorage.getItem('qc-convert-quote');
      if (!stored) return;
      const quoteData = JSON.parse(stored);

      if (quoteData.quoteId === fromQuoteId) {
        setFromQuoteNumber(quoteData.quoteNumber || fromQuoteId);

        // Pre-fill client
        if (quoteData.clientId) {
          setSelectedClientId(quoteData.clientId);
        }

        // Pre-fill line items
        if (quoteData.lineItems && quoteData.lineItems.length > 0) {
          setLineItems(
            quoteData.lineItems.map((item: any) => ({
              id: Math.random().toString(36).substr(2, 9),
              name: item.name || '',
              description: item.description || '',
              quantity: item.quantity || 1,
              rate: item.rate || 0,
            }))
          );
        }

        // Pre-fill notes
        if (quoteData.notes) {
          setNotes(quoteData.notes);
        }

        // Clean up localStorage
        localStorage.removeItem('qc-convert-quote');
      }
    } catch {
      // ignore parse errors
    }
  }, [searchParams]);

  // Derived State
  const selectedClient = useMemo(
    () => clients.find((c) => c.id === selectedClientId),
    [clients, selectedClientId]
  );

  const tpl = (INVOICE_TEMPLATES[templateName] ?? INVOICE_TEMPLATES.clean) as InvoiceTemplate;

  // Bug #178: Round each line item to avoid floating-point precision errors
  const subtotal =
    Math.round(
      lineItems.reduce((acc, item) => acc + Math.round(item.quantity * item.rate * 100) / 100, 0) *
        100
    ) / 100;

  // Parse tax rate from the select value
  const parsedTaxPercent = useMemo(() => {
    if (taxRate === 'custom') {
      return parseFloat(customTaxRate) || 0;
    }
    const match = taxRate.match(/^(\d+(?:\.\d+)?)/);
    return match?.[1] ? parseFloat(match[1]) : 0;
  }, [taxRate, customTaxRate]);

  const discountAmount =
    Math.round((discountType === 'percent' ? subtotal * (discount / 100) : discount) * 100) / 100;
  const discountedSubtotal = Math.max(0, Math.round((subtotal - discountAmount) * 100) / 100);
  const taxAmount = Math.round(discountedSubtotal * (parsedTaxPercent / 100) * 100) / 100;
  const total = Math.max(0, Math.round((discountedSubtotal + taxAmount) * 100) / 100);

  // ─── Handlers ────────────────────────────────────────
  const [addItemOpen, setAddItemOpen] = useState(false);
  const [savedItems, setSavedItems] = useState<SavedLineItemData[]>([]);

  // Load saved items and invoice templates for dropdowns
  const [invoiceTemplates, setInvoiceTemplates] = useState<
    { id: string; name: string; lineItems: InvoiceTemplateLineItem[] }[]
  >([]);
  useEffect(() => {
    getSavedLineItems()
      .then(setSavedItems)
      .catch(() => {});
    getInvoiceTemplates()
      .then(({ data }) => {
        setInvoiceTemplates(data.map((t) => ({ id: t.id, name: t.name, lineItems: t.lineItems })));
      })
      .catch(() => {});
  }, []);

  const addLineItem = () => {
    setLineItems([
      ...lineItems,
      {
        id: Math.random().toString(36).substr(2, 9),
        name: '',
        description: '',
        quantity: 1,
        rate: 0,
      },
    ]);
  };

  const removeLineItem = (id: string) => {
    setLineItems(lineItems.filter((item) => item.id !== id));
  };

  const updateLineItem = (id: string, field: keyof LineItem, value: string | number) => {
    setLineItems(lineItems.map((item) => (item.id === id ? { ...item, [field]: value } : item)));
  };

  const handleSubmit = async (isDraft: boolean) => {
    if (!selectedClientId) {
      toast.error('Please select a client');
      return;
    }
    if (lineItems.length === 0 || lineItems.every((item) => !item.name)) {
      toast.error('Please add at least one line item');
      return;
    }

    setLoading(true);
    try {
      const result = await createInvoice({
        clientId: selectedClientId,
        title: 'Invoice',
        currency: selectedCurrency,
        isDraft,
        dueDate: dueDate
          ? dueDate.toISOString().split('T')[0]!
          : new Date().toISOString().split('T')[0]!,
        lineItems: lineItems
          .filter((item) => item.name.trim())
          .map((item) => ({
            name: item.name,
            description: item.description || undefined,
            quantity: item.quantity,
            rate: item.rate,
            taxRate: parsedTaxPercent || undefined,
          })),
      });

      if (result.success && result.invoice?.id) {
        if (!isDraft) {
          const sendResult = await sendInvoice(result.invoice.id);
          if (!sendResult.success) {
            toast.error(
              sendResult.error ||
                'Invoice created but email could not be sent. You can resend from the invoices list.'
            );
            router.push('/invoices');
            return;
          }
        }
        toast.success(isDraft ? 'Draft Saved' : 'Invoice Sent');
        router.push('/invoices');
      } else if ('error' in result) {
        toast.error(result.error);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to create invoice';
      toast.error(message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex h-[calc(100vh-64px)] flex-col">
      {/* From Quote Banner */}
      {fromQuoteNumber && (
        <div className="border-b border-purple-200 bg-purple-50 px-6 py-3 dark:border-purple-800 dark:bg-purple-950">
          <p className="text-sm font-medium text-purple-700 dark:text-purple-300">
            Creating invoice from Quote #{fromQuoteNumber}
          </p>
        </div>
      )}

      {/* ─── Main Content ────────────────────────────── */}
      <div className="flex-1 overflow-hidden">
        <div className="grid h-full lg:grid-cols-[1fr,420px] xl:grid-cols-[1fr,480px]">
          {/* ═══════════════════════════════════════════ */}
          {/* LEFT PANEL — Editor                        */}
          {/* ═══════════════════════════════════════════ */}
          <div className="no-scrollbar bg-background overflow-y-auto border-r">
            <div className="mx-auto max-w-[640px] space-y-0 px-8 py-10">
              {/* ─── Invoice Details Section ─────────── */}
              <div className="pb-8">
                <div className="mb-6 flex items-center justify-between">
                  <h3 className="font-display text-xl font-semibold tracking-tight">
                    Invoice Details
                  </h3>
                  <Popover>
                    <PopoverTrigger asChild>
                      <button className="text-muted-foreground hover:text-primary flex items-center gap-1 text-sm transition-colors">
                        Options
                        <ChevronDown className="h-3.5 w-3.5" />
                      </button>
                    </PopoverTrigger>
                    <PopoverContent align="end" className="w-56 p-1">
                      <div
                        role="menuitem"
                        className="hover:bg-muted flex w-full cursor-pointer items-center justify-between rounded-md px-3 py-2.5 text-sm transition-colors"
                        onClick={() => setShowBillAsCompany(!showBillAsCompany)}
                      >
                        <div className="flex items-center gap-2.5">
                          <Building2 className="text-muted-foreground h-4 w-4" />
                          <span>Bill as Company</span>
                        </div>
                        <Switch
                          checked={showBillAsCompany}
                          onCheckedChange={setShowBillAsCompany}
                          className="scale-75"
                        />
                      </div>
                      <button
                        className="hover:bg-muted flex w-full items-center gap-2.5 rounded-md px-3 py-2.5 text-sm transition-colors"
                        onClick={() => setShowIssueDate(!showIssueDate)}
                      >
                        <CalendarIcon className="text-muted-foreground h-4 w-4" />
                        <span>Edit Issue Date</span>
                        {showIssueDate && <Check className="text-primary ml-auto h-3.5 w-3.5" />}
                      </button>
                      <button
                        className="hover:bg-muted flex w-full items-center gap-2.5 rounded-md px-3 py-2.5 text-sm transition-colors"
                        onClick={() => setShowPoNumber(!showPoNumber)}
                      >
                        <Hash className="text-muted-foreground h-4 w-4" />
                        <span>Add PO Number</span>
                        {showPoNumber && <Check className="text-primary ml-auto h-3.5 w-3.5" />}
                      </button>
                      <button
                        className="hover:bg-muted flex w-full items-center gap-2.5 rounded-md px-3 py-2.5 text-sm transition-colors"
                        onClick={() => setShowCustomField(!showCustomField)}
                      >
                        <Pencil className="text-muted-foreground h-4 w-4" />
                        <span>Add Custom Field</span>
                        {showCustomField && <Check className="text-primary ml-auto h-3.5 w-3.5" />}
                      </button>
                      <div className="bg-border/50 my-1 h-px" />
                      <button
                        className="hover:bg-muted flex w-full items-center gap-2.5 rounded-md px-3 py-2.5 text-sm transition-colors"
                        onClick={() => setShowDescription(!showDescription)}
                      >
                        <FileText className="text-muted-foreground h-4 w-4" />
                        <span>Add Description</span>
                        {showDescription && <Check className="text-primary ml-auto h-3.5 w-3.5" />}
                      </button>
                      <button
                        className="hover:bg-muted flex w-full items-center gap-2.5 rounded-md px-3 py-2.5 text-sm transition-colors"
                        onClick={() => setShowAttachments(!showAttachments)}
                      >
                        <Paperclip className="text-muted-foreground h-4 w-4" />
                        <span>Add Attachments</span>
                        {showAttachments && <Check className="text-primary ml-auto h-3.5 w-3.5" />}
                      </button>
                      <button
                        className="hover:bg-muted flex w-full items-center gap-2.5 rounded-md px-3 py-2.5 text-sm transition-colors"
                        onClick={() => setShowEvent(!showEvent)}
                      >
                        <CalendarPlus className="text-muted-foreground h-4 w-4" />
                        <span>Add Event</span>
                        {showEvent && <Check className="text-primary ml-auto h-3.5 w-3.5" />}
                      </button>
                    </PopoverContent>
                  </Popover>
                </div>

                {/* Client Selector / Display */}
                <div className="mb-5">
                  {selectedClient ? (
                    <div className="border-border/60 bg-muted/20 flex items-center justify-between rounded-lg border px-4 py-3">
                      <div className="flex items-center gap-3">
                        <div className="bg-primary/10 text-primary flex h-9 w-9 items-center justify-center rounded-full text-sm font-semibold">
                          {selectedClient.name
                            .split(' ')
                            .map((n) => n[0])
                            .join('')
                            .toUpperCase()
                            .slice(0, 2)}
                        </div>
                        <div>
                          <p className="text-sm font-medium">{selectedClient.name}</p>
                          <p className="text-muted-foreground text-xs">{selectedClient.email}</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="text-muted-foreground h-8 w-8"
                          onClick={() => setSelectedClientId('')}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="text-muted-foreground h-8 w-8"
                          onClick={() => setSelectedClientId('')}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-1.5">
                      <Label className="text-muted-foreground text-xs">Customer</Label>
                      <Select value={selectedClientId} onValueChange={setSelectedClientId}>
                        <SelectTrigger className="h-11">
                          <SelectValue placeholder="Select a customer" />
                        </SelectTrigger>
                        <SelectContent>
                          {clients.length === 0 ? (
                            <SelectItem value="_none" disabled>
                              No clients found
                            </SelectItem>
                          ) : (
                            clients.map((client) => (
                              <SelectItem key={client.id} value={client.id}>
                                <div className="flex items-center gap-2">
                                  <span>{client.name}</span>
                                  {client.email && (
                                    <span className="text-muted-foreground text-xs">
                                      {client.email}
                                    </span>
                                  )}
                                </div>
                              </SelectItem>
                            ))
                          )}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                </div>

                {/* Bill as Company — shown when toggled */}
                {showBillAsCompany && (
                  <div className="mb-4 space-y-1.5">
                    <Label className="text-muted-foreground text-xs">Company Name</Label>
                    <Input
                      value={companyName}
                      onChange={(e) => setCompanyName(e.target.value)}
                      className="h-10"
                      placeholder="Enter company name"
                    />
                  </div>
                )}

                {/* Issue Date / Due Date / Invoice Number / Tax Rate — Compact Row */}
                <div
                  className={cn(
                    'grid gap-4',
                    showIssueDate ? 'grid-cols-2 md:grid-cols-4' : 'grid-cols-3'
                  )}
                >
                  {showIssueDate && (
                    <div className="space-y-1.5">
                      <Label className="text-muted-foreground text-xs">Issue Date</Label>
                      <Popover>
                        <PopoverTrigger asChild>
                          <Button
                            variant="outline"
                            className={cn(
                              'bg-card h-11 w-full justify-start text-left text-sm font-normal shadow-none',
                              !issueDate && 'text-muted-foreground'
                            )}
                          >
                            <CalendarIcon className="text-muted-foreground mr-1 h-3.5 w-3.5 flex-shrink-0" />
                            <span className="truncate">
                              {issueDate ? format(issueDate, 'MMM dd, yyyy') : 'Pick date'}
                            </span>
                          </Button>
                        </PopoverTrigger>
                        <PopoverContent className="w-auto p-0" align="start">
                          <Calendar
                            mode="single"
                            selected={issueDate}
                            onSelect={setIssueDate}
                            initialFocus
                          />
                        </PopoverContent>
                      </Popover>
                    </div>
                  )}
                  <div className="space-y-1.5">
                    <Label className="text-muted-foreground text-xs">Due Date</Label>
                    <Popover>
                      <PopoverTrigger asChild>
                        <Button
                          variant="outline"
                          className={cn(
                            'bg-card h-11 w-full justify-start text-left text-sm font-normal shadow-none',
                            !dueDate && 'text-muted-foreground'
                          )}
                        >
                          <CalendarIcon className="text-muted-foreground mr-1 h-3.5 w-3.5 flex-shrink-0" />
                          <span className="truncate">
                            {dueDate ? format(dueDate, 'MMM dd, yyyy') : 'Pick date'}
                          </span>
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent className="w-auto p-0" align="start">
                        <Calendar
                          mode="single"
                          selected={dueDate}
                          onSelect={setDueDate}
                          initialFocus
                        />
                      </PopoverContent>
                    </Popover>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-muted-foreground text-xs">Invoice Number</Label>
                    <Input value={invoiceNumber} readOnly disabled className="h-11 opacity-60" />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-muted-foreground text-xs">Tax rate</Label>
                    <Select
                      value={taxRate}
                      onValueChange={(v) => {
                        setTaxRate(v);
                        if (v !== 'custom') setCustomTaxRate('');
                      }}
                    >
                      <SelectTrigger className="h-11">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="0% - Default">0% - Default</SelectItem>
                        {taxRates
                          .filter((t) => t.isActive)
                          .map((tr) => (
                            <SelectItem key={tr.id} value={`${tr.rate}% - ${tr.name}`}>
                              {tr.rate}% - {tr.name}
                            </SelectItem>
                          ))}
                        {taxRates.filter((t) => t.isActive).length === 0 && (
                          <>
                            <SelectItem value="5% - GST">5% - GST</SelectItem>
                            <SelectItem value="10% - VAT">10% - VAT</SelectItem>
                            <SelectItem value="18% - GST">18% - GST</SelectItem>
                          </>
                        )}
                        <SelectItem value="custom">Set Custom Rate</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                {/* Custom Tax Rate Input */}
                {taxRate === 'custom' && (
                  <div className="mt-3 space-y-1.5">
                    <Label className="text-muted-foreground text-xs">Custom Tax Rate (%)</Label>
                    <Input
                      type="number"
                      min="0"
                      max="100"
                      step="0.1"
                      value={customTaxRate}
                      onChange={(e) => setCustomTaxRate(e.target.value)}
                      className="h-10 w-32"
                      placeholder="e.g. 12.5"
                    />
                  </div>
                )}

                {/* Currency Selector */}
                <div className="mt-3 space-y-1.5">
                  <Label className="text-muted-foreground text-xs">Currency</Label>
                  <Select value={selectedCurrency} onValueChange={setSelectedCurrency}>
                    <SelectTrigger className="h-10 max-w-[200px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="USD">USD - US Dollar</SelectItem>
                      <SelectItem value="EUR">EUR - Euro</SelectItem>
                      <SelectItem value="GBP">GBP - British Pound</SelectItem>
                      <SelectItem value="INR">INR - Indian Rupee</SelectItem>
                      <SelectItem value="CAD">CAD - Canadian Dollar</SelectItem>
                      <SelectItem value="AUD">AUD - Australian Dollar</SelectItem>
                      <SelectItem value="JPY">JPY - Japanese Yen</SelectItem>
                      <SelectItem value="SGD">SGD - Singapore Dollar</SelectItem>
                      <SelectItem value="NZD">NZD - New Zealand Dollar</SelectItem>
                      <SelectItem value="CHF">CHF - Swiss Franc</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {/* PO Number — shown when toggled */}
                {showPoNumber && (
                  <div className="mt-3 space-y-1.5">
                    <Label className="text-muted-foreground text-xs">Purchase Order #</Label>
                    <Input
                      value={poNumber}
                      onChange={(e) => setPoNumber(e.target.value)}
                      placeholder="PO-0000"
                      className="h-10 max-w-[200px]"
                    />
                  </div>
                )}

                {/* Custom Field — shown when toggled */}
                {showCustomField && (
                  <div className="mt-3 grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <Label className="text-muted-foreground text-xs">Field Label</Label>
                      <Input
                        value={customFieldLabel}
                        onChange={(e) => setCustomFieldLabel(e.target.value)}
                        placeholder="e.g. Project Name"
                        className="h-10"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-muted-foreground text-xs">Field Value</Label>
                      <Input
                        value={customFieldValue}
                        onChange={(e) => setCustomFieldValue(e.target.value)}
                        placeholder="e.g. Website Redesign"
                        className="h-10"
                      />
                    </div>
                  </div>
                )}
              </div>

              {/* ─── Add Enhancements — Dropdown ─────── */}
              {/* Enhancement fields — shown when toggled */}
              {(showDescription || showAttachments || showEvent) && (
                <div className="mt-8 space-y-6">
                  {showDescription && (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <Label className="text-muted-foreground text-xs">Description</Label>
                        <button
                          className="text-muted-foreground hover:text-destructive text-xs transition-colors"
                          onClick={() => {
                            setShowDescription(false);
                            setDescription('');
                          }}
                        >
                          Remove
                        </button>
                      </div>
                      <Textarea
                        value={description}
                        onChange={(e) => setDescription(e.target.value)}
                        className="min-h-[80px] resize-none"
                        placeholder="Describe this project or service..."
                      />
                    </div>
                  )}
                  {showAttachments && (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <Label className="text-muted-foreground text-xs">Attachments</Label>
                        <button
                          className="text-muted-foreground hover:text-destructive text-xs transition-colors"
                          onClick={() => setShowAttachments(false)}
                        >
                          Remove
                        </button>
                      </div>
                      <div className="text-muted-foreground hover:border-primary/30 bg-muted/10 cursor-pointer rounded-lg border-2 border-dashed px-4 py-6 text-center text-sm transition-colors">
                        <Paperclip className="mx-auto mb-2 h-5 w-5 opacity-50" />
                        <p>Click to upload or drag files here</p>
                        <p className="mt-1 text-xs">PDF, Images up to 10MB</p>
                      </div>
                    </div>
                  )}
                  {showEvent && (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <Label className="text-muted-foreground text-xs">Event Details</Label>
                        <button
                          className="text-muted-foreground hover:text-destructive text-xs transition-colors"
                          onClick={() => {
                            setShowEvent(false);
                            setEventName('');
                            setEventDate(undefined);
                          }}
                        >
                          Remove
                        </button>
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <Input
                          value={eventName}
                          onChange={(e) => setEventName(e.target.value)}
                          className="h-10"
                          placeholder="Event name"
                        />
                        <Popover>
                          <PopoverTrigger asChild>
                            <Button
                              variant="outline"
                              className={cn(
                                'h-10 w-full justify-start text-left text-sm font-normal',
                                !eventDate && 'text-muted-foreground'
                              )}
                            >
                              <CalendarIcon className="mr-2 h-3.5 w-3.5" />
                              {eventDate ? format(eventDate, 'MMM do, yyyy') : 'Event date'}
                            </Button>
                          </PopoverTrigger>
                          <PopoverContent className="w-auto p-0" align="start">
                            <Calendar
                              mode="single"
                              selected={eventDate}
                              onSelect={setEventDate}
                              initialFocus
                            />
                          </PopoverContent>
                        </Popover>
                      </div>
                    </div>
                  )}
                </div>
              )}

              <Separator className="bg-border/60" />

              {/* ─── Items Section ────────────────────── */}
              <div className="py-8">
                <div className="mb-5 flex items-center justify-between">
                  <h3 className="font-display text-xl font-semibold tracking-tight">Items</h3>
                  <Popover>
                    <PopoverTrigger asChild>
                      <button className="text-muted-foreground hover:text-primary flex items-center gap-1 text-sm transition-colors">
                        Templates
                        <ChevronDown className="h-3.5 w-3.5" />
                      </button>
                    </PopoverTrigger>
                    <PopoverContent align="end" className="w-64 p-1">
                      <p className="text-muted-foreground px-2 py-1.5 text-xs font-medium">
                        Load a template
                      </p>
                      {invoiceTemplates.length === 0 ? (
                        <div className="py-4 text-center">
                          <p className="text-muted-foreground text-xs">No templates yet</p>
                          <button
                            onClick={() => router.push('/templates/invoices')}
                            className="text-primary hover:text-primary/80 mt-1 text-xs"
                          >
                            Create templates →
                          </button>
                        </div>
                      ) : (
                        invoiceTemplates.map((template) => (
                          <button
                            key={template.id}
                            onClick={() => {
                              setLineItems(
                                template.lineItems.map((item) => ({
                                  id: Math.random().toString(36).substr(2, 9),
                                  name: item.name,
                                  description: item.description || '',
                                  quantity: item.qty,
                                  rate: item.rate,
                                }))
                              );
                            }}
                            className="hover:bg-muted flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left text-sm transition-colors"
                          >
                            <FileText className="text-muted-foreground h-4 w-4" />
                            <span className="font-medium">{template.name}</span>
                          </button>
                        ))
                      )}
                    </PopoverContent>
                  </Popover>
                </div>

                {/* Items Table Header */}
                {lineItems.length > 0 && (
                  <div className="mb-3 grid grid-cols-[1fr,80px,60px,32px] gap-3 px-3">
                    <span className="text-muted-foreground text-[11px] font-semibold uppercase tracking-widest">
                      Items
                    </span>
                    <span className="text-muted-foreground text-[11px] font-semibold uppercase tracking-widest">
                      Rate
                    </span>
                    <span className="text-muted-foreground text-[11px] font-semibold uppercase tracking-widest">
                      Qty
                    </span>
                    <span />
                  </div>
                )}

                {/* Line Items */}
                <div className="mb-5 space-y-0">
                  {lineItems.map((item, index) => (
                    <div
                      key={item.id}
                      className={cn(
                        'hover:bg-muted/30 group px-3 py-3 transition-colors',
                        index !== lineItems.length - 1 && 'border-border/40 border-b'
                      )}
                    >
                      <div className="grid grid-cols-[1fr,80px,60px,32px] items-center gap-3">
                        <Input
                          placeholder="Item name"
                          value={item.name}
                          onChange={(e) => updateLineItem(item.id, 'name', e.target.value)}
                          className="h-9 border-0 !bg-transparent px-0 text-sm font-medium shadow-none focus-visible:ring-0"
                        />
                        <Input
                          type="number"
                          min="0"
                          step="0.01"
                          value={item.rate || ''}
                          onChange={(e) =>
                            updateLineItem(item.id, 'rate', parseFloat(e.target.value) || 0)
                          }
                          className="h-9 text-sm"
                          placeholder="0"
                        />
                        <Input
                          type="number"
                          min="1"
                          value={item.quantity || ''}
                          onChange={(e) =>
                            updateLineItem(
                              item.id,
                              'quantity',
                              // Low #58: Use parseFloat to support fractional quantities (e.g. 0.5 hours)
                              parseFloat(e.target.value) || 1
                            )
                          }
                          className="h-9 text-sm"
                          placeholder="1"
                        />
                        <Button
                          variant="ghost"
                          size="icon"
                          className="text-muted-foreground hover:text-destructive h-7 w-7 opacity-0 transition-opacity group-hover:opacity-100"
                          onClick={() => removeLineItem(item.id)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                      <Input
                        placeholder="Add a description..."
                        value={item.description}
                        onChange={(e) => updateLineItem(item.id, 'description', e.target.value)}
                        className="text-muted-foreground mt-0.5 h-7 border-0 !bg-transparent px-0 text-xs shadow-none focus-visible:ring-0"
                      />
                    </div>
                  ))}
                </div>

                {/* Add Items Dropdown */}
                <Popover open={addItemOpen} onOpenChange={setAddItemOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      className="text-muted-foreground hover:text-primary hover:border-primary/40 hover:bg-primary-50/50 h-11 w-full border-2 border-dashed text-sm font-medium transition-all"
                    >
                      <Plus className="mr-2 h-4 w-4" />
                      Add Items
                      <ChevronDown className="ml-2 h-3.5 w-3.5" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent
                    className="p-0"
                    align="start"
                    style={{ width: 'var(--radix-popover-trigger-width)' }}
                  >
                    <Command>
                      <CommandInput placeholder="Search saved items..." />
                      <CommandList className="max-h-[280px]">
                        <CommandEmpty>No items found.</CommandEmpty>
                        <CommandGroup>
                          <CommandItem
                            onSelect={() => {
                              addLineItem();
                              setAddItemOpen(false);
                            }}
                            className="py-2.5"
                          >
                            <Plus className="text-muted-foreground mr-2 h-4 w-4" />
                            <span className="font-medium">Blank Item</span>
                          </CommandItem>
                        </CommandGroup>
                        <CommandSeparator />
                        <CommandGroup heading="Saved Items">
                          {savedItems.length === 0 ? (
                            <div className="py-4 text-center">
                              <p className="text-muted-foreground text-xs">No saved items yet</p>
                              <button
                                onClick={() => {
                                  setAddItemOpen(false);
                                  router.push('/templates/invoice-items');
                                }}
                                className="text-primary hover:text-primary/80 mt-1 text-xs"
                              >
                                Create saved items →
                              </button>
                            </div>
                          ) : (
                            savedItems.map((saved) => (
                              <CommandItem
                                key={saved.id}
                                value={saved.name}
                                onSelect={() => {
                                  setLineItems([
                                    ...lineItems,
                                    {
                                      id: Math.random().toString(36).substr(2, 9),
                                      name: saved.name,
                                      description: saved.description || '',
                                      quantity: 1,
                                      rate: saved.price,
                                    },
                                  ]);
                                  setAddItemOpen(false);
                                }}
                                className="py-2.5"
                              >
                                <div className="min-w-0 flex-1">
                                  <p className="truncate text-sm font-medium">{saved.name}</p>
                                  {saved.description && (
                                    <p className="text-muted-foreground truncate text-xs">
                                      {saved.description}
                                    </p>
                                  )}
                                </div>
                                {saved.price > 0 && (
                                  <span className="text-muted-foreground ml-3 shrink-0 text-xs font-medium tabular-nums">
                                    {formatMoney(saved.price, selectedCurrency)}
                                  </span>
                                )}
                              </CommandItem>
                            ))
                          )}
                        </CommandGroup>
                      </CommandList>
                    </Command>
                  </PopoverContent>
                </Popover>
              </div>

              <Separator className="bg-border/60" />

              {/* ─── Payment Settings ─────────────────── */}
              <div className="py-8">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="font-display text-xl font-semibold tracking-tight">
                      Payment Settings
                    </h3>
                    <p className="text-muted-foreground mt-1 text-[13px]">
                      Payment methods are setup in your settings page.
                    </p>
                  </div>
                  <Popover>
                    <PopoverTrigger asChild>
                      <button className="text-muted-foreground hover:text-primary flex items-center gap-1 text-sm transition-colors">
                        Options
                        <ChevronDown className="h-3.5 w-3.5" />
                      </button>
                    </PopoverTrigger>
                    <PopoverContent align="end" className="w-56 p-1">
                      <p className="text-muted-foreground px-3 py-1.5 text-xs font-medium uppercase tracking-wider">
                        Payment settings
                      </p>
                      <button
                        className="hover:bg-muted flex w-full items-center gap-2.5 rounded-md px-3 py-2.5 text-sm transition-colors"
                        onClick={() => setShowDeposit(!showDeposit)}
                      >
                        <Banknote className="text-muted-foreground h-4 w-4" />
                        <span>Deposit/Payments</span>
                        {showDeposit && <Check className="text-primary ml-auto h-3.5 w-3.5" />}
                      </button>
                      <button
                        className="hover:bg-muted flex w-full items-center gap-2.5 rounded-md px-3 py-2.5 text-sm transition-colors"
                        onClick={() => setShowDiscount(!showDiscount)}
                      >
                        <span className="text-muted-foreground flex h-4 w-4 items-center justify-center text-xs font-bold">
                          %
                        </span>
                        <span>Discount</span>
                        {showDiscount && <Check className="text-primary ml-auto h-3.5 w-3.5" />}
                      </button>
                      <div
                        role="menuitem"
                        className="hover:bg-muted flex w-full cursor-pointer items-center justify-between rounded-md px-3 py-2.5 text-sm transition-colors"
                        onClick={() => setAllowTipping(!allowTipping)}
                      >
                        <div className="flex items-center gap-2.5">
                          <span className="text-muted-foreground flex h-4 w-4 items-center justify-center text-xs">
                            &#128176;
                          </span>
                          <span>Tipping</span>
                        </div>
                        <Switch
                          checked={allowTipping}
                          onCheckedChange={setAllowTipping}
                          className="scale-75"
                        />
                      </div>
                      <button
                        className="hover:bg-muted flex w-full items-center gap-2.5 rounded-md px-3 py-2.5 text-sm transition-colors"
                        onClick={() => setShowRecurring(!showRecurring)}
                      >
                        <RotateCcw className="text-muted-foreground h-4 w-4" />
                        <span>Recurring Invoice</span>
                        <HelpCircle className="text-muted-foreground/50 h-3 w-3" />
                        {showRecurring && <Check className="text-primary ml-auto h-3.5 w-3.5" />}
                      </button>
                      <button
                        className="hover:bg-muted flex w-full items-center gap-2.5 rounded-md px-3 py-2.5 text-sm transition-colors"
                        onClick={() => setShowCustomLinks(!showCustomLinks)}
                      >
                        <Link2 className="text-muted-foreground h-4 w-4" />
                        <span>Custom Links</span>
                        <HelpCircle className="text-muted-foreground/50 h-3 w-3" />
                        {showCustomLinks && <Check className="text-primary ml-auto h-3.5 w-3.5" />}
                      </button>
                      <button
                        className="hover:bg-muted flex w-full items-center justify-between rounded-md px-3 py-2.5 text-sm transition-colors"
                        onClick={() => setPdfPaymentLink(!pdfPaymentLink)}
                      >
                        <div className="flex items-center gap-2.5">
                          <FileText className="text-muted-foreground h-4 w-4" />
                          <span>PDF Payment Link</span>
                          <HelpCircle className="text-muted-foreground/50 h-3 w-3" />
                        </div>
                        {pdfPaymentLink && <Check className="text-primary h-3.5 w-3.5" />}
                      </button>
                      <Separator className="my-1" />
                      <p className="text-muted-foreground px-3 py-1.5 text-xs font-medium uppercase tracking-wider">
                        Payment methods
                      </p>
                      <button className="hover:bg-muted flex w-full items-center gap-2.5 rounded-md px-3 py-2.5 text-sm transition-colors">
                        <Plus className="text-muted-foreground h-4 w-4" />
                        <span>Add Payment Options</span>
                      </button>
                    </PopoverContent>
                  </Popover>
                </div>

                {/* Payment settings fields — shown when toggled */}
                {(showDeposit || showDiscount || showRecurring || showCustomLinks) && (
                  <div className="mt-4 space-y-3 border-t border-dashed pt-3">
                    {showDiscount && (
                      <div className="space-y-1.5">
                        <div className="flex items-center justify-between">
                          <Label className="text-muted-foreground text-xs">Discount</Label>
                          <button
                            className="text-muted-foreground hover:text-destructive text-xs transition-colors"
                            onClick={() => {
                              setShowDiscount(false);
                              setDiscount(0);
                            }}
                          >
                            Remove
                          </button>
                        </div>
                        <div className="flex items-center gap-2">
                          <Input
                            type="number"
                            min="0"
                            value={discount || ''}
                            onChange={(e) => setDiscount(parseFloat(e.target.value) || 0)}
                            className="h-10"
                            placeholder="0.00"
                          />
                          <Select
                            value={discountType}
                            onValueChange={(v) => setDiscountType(v as 'flat' | 'percent')}
                          >
                            <SelectTrigger className="h-10 w-[100px]">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="flat">Flat</SelectItem>
                              <SelectItem value="percent">%</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                      </div>
                    )}
                    {showDeposit && (
                      <div className="space-y-1.5">
                        <div className="flex items-center justify-between">
                          <Label className="text-muted-foreground text-xs">Deposit Required</Label>
                          <button
                            className="text-muted-foreground hover:text-destructive text-xs transition-colors"
                            onClick={() => {
                              setShowDeposit(false);
                              setDepositAmount(0);
                            }}
                          >
                            Remove
                          </button>
                        </div>
                        <Input
                          type="number"
                          min="0"
                          value={depositAmount || ''}
                          onChange={(e) => setDepositAmount(parseFloat(e.target.value) || 0)}
                          className="h-10"
                          placeholder="0.00"
                        />
                      </div>
                    )}
                    {showRecurring && (
                      <div className="space-y-1.5">
                        <div className="flex items-center justify-between">
                          <Label className="text-muted-foreground text-xs">
                            Recurring Schedule
                          </Label>
                          <button
                            className="text-muted-foreground hover:text-destructive text-xs transition-colors"
                            onClick={() => setShowRecurring(false)}
                          >
                            Remove
                          </button>
                        </div>
                        <Select value={recurringInterval} onValueChange={setRecurringInterval}>
                          <SelectTrigger className="h-10">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="weekly">Weekly</SelectItem>
                            <SelectItem value="biweekly">Bi-weekly</SelectItem>
                            <SelectItem value="monthly">Monthly</SelectItem>
                            <SelectItem value="quarterly">Quarterly</SelectItem>
                            <SelectItem value="yearly">Yearly</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    )}
                    {showCustomLinks && (
                      <div className="space-y-1.5">
                        <div className="flex items-center justify-between">
                          <Label className="text-muted-foreground text-xs">Custom Link</Label>
                          <button
                            className="text-muted-foreground hover:text-destructive text-xs transition-colors"
                            onClick={() => {
                              setShowCustomLinks(false);
                              setCustomLinkUrl('');
                              setCustomLinkLabel('');
                            }}
                          >
                            Remove
                          </button>
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                          <Input
                            value={customLinkLabel}
                            onChange={(e) => setCustomLinkLabel(e.target.value)}
                            className="h-10"
                            placeholder="Link label"
                          />
                          <Input
                            value={customLinkUrl}
                            onChange={(e) => setCustomLinkUrl(e.target.value)}
                            className="h-10"
                            placeholder="https://..."
                          />
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>

              <Separator className="bg-border/60" />

              {/* ─── Memo Section ─────────────────────── */}
              <div className="py-8">
                <h3 className="font-display mb-5 text-xl font-semibold tracking-tight">Memo</h3>
                <div className="space-y-2">
                  <Label className="text-muted-foreground text-[11px] font-semibold uppercase tracking-widest">
                    Memo
                  </Label>
                  <Textarea
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    className="min-h-[80px] resize-none text-sm"
                    placeholder="Thank you for your business!"
                  />
                </div>
              </div>

              {/* ─── Bottom Action Bar ────────────────── */}
              <div className="flex items-center gap-3 border-t pb-8 pt-4">
                <Button
                  onClick={() => handleSubmit(false)}
                  disabled={loading}
                  size="lg"
                  className="bg-red-500 px-8 text-white hover:bg-red-600"
                >
                  {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Create & Send
                </Button>
                <Button
                  variant="outline"
                  size="lg"
                  onClick={() => handleSubmit(true)}
                  disabled={loading}
                >
                  Save Draft
                </Button>
              </div>
            </div>
          </div>

          {/* ═══════════════════════════════════════════ */}
          {/* RIGHT PANEL — Live Preview                 */}
          {/* ═══════════════════════════════════════════ */}
          <div className="no-scrollbar bg-muted/30 flex flex-col overflow-y-auto">
            {/* Preview Tabs */}
            <div className="bg-background/95 supports-[backdrop-filter]:bg-background/60 sticky top-0 z-10 border-b px-4 pb-3 pt-4 backdrop-blur">
              <Tabs value={previewTab} onValueChange={(v) => setPreviewTab(v as PreviewTab)}>
                <TabsList className="grid h-10 w-full grid-cols-3">
                  <TabsTrigger
                    value="payment"
                    className="data-[state=active]:text-foreground text-xs"
                  >
                    Payment Page
                  </TabsTrigger>
                  <TabsTrigger
                    value="email"
                    className="data-[state=active]:text-foreground text-xs"
                  >
                    Email Preview
                  </TabsTrigger>
                  <TabsTrigger value="pdf" className="data-[state=active]:text-foreground text-xs">
                    Invoice PDF
                  </TabsTrigger>
                </TabsList>
              </Tabs>
            </div>

            {/* ═══ PAYMENT PAGE TAB ═══════════════════ */}
            {previewTab === 'payment' && (
              <div className="flex-1 p-4">
                <div
                  className={cn(
                    'bg-card relative overflow-hidden border shadow-sm transition-all duration-300',
                    tpl.cardClass,
                    tpl.style === 'glassmorphism' && 'border-white/40 bg-white/70 backdrop-blur-xl'
                  )}
                  style={tpl.bgTint ? { background: tpl.bgTint } : undefined}
                >
                  {/* ─── Subtle top-left wave decoration ─── */}
                  <svg
                    className="pointer-events-none absolute left-0 top-0"
                    viewBox="0 0 200 120"
                    fill="none"
                    style={{ width: '45%', height: '100px' }}
                  >
                    <path
                      d="M0 0 L0 80 Q60 72 120 40 Q160 18 200 0 Z"
                      fill={tpl.accent}
                      opacity="0.05"
                    />
                    <path
                      d="M0 0 L0 50 Q40 44 80 24 Q110 10 140 0 Z"
                      fill={tpl.accent}
                      opacity="0.03"
                    />
                  </svg>

                  {/* ─── Theme Picker ─── */}
                  <Popover>
                    <PopoverTrigger asChild>
                      <button
                        className="bg-muted/60 hover:bg-muted absolute right-3 top-3 z-20 flex h-7 w-7 items-center justify-center rounded-full transition-colors"
                        title="Change template"
                      >
                        <Palette className="text-muted-foreground h-3.5 w-3.5" />
                      </button>
                    </PopoverTrigger>
                    <PopoverContent className="w-[280px] p-3" align="end" side="bottom">
                      <p className="text-muted-foreground mb-2.5 text-xs font-medium">
                        Invoice Style
                      </p>
                      <div className="grid grid-cols-3 gap-1.5">
                        {Object.entries(INVOICE_TEMPLATES).map(([key, t]) => (
                          <button
                            key={key}
                            onClick={() => setTemplateName(key as TemplateName)}
                            className={cn(
                              'hover:bg-muted flex flex-col items-center gap-1 rounded-lg p-1.5 transition-all',
                              templateName === key && 'ring-primary bg-muted ring-2 ring-offset-1'
                            )}
                          >
                            <div className="border-border/50 relative flex h-10 w-full flex-col items-center justify-center gap-0.5 overflow-hidden rounded-md border bg-white">
                              {/* Unified mini preview: circle + lines */}
                              <div
                                className="h-2.5 w-2.5 rounded-full"
                                style={{
                                  backgroundColor: `${t.accent}20`,
                                  border: `1.5px solid ${t.accent}`,
                                }}
                              />
                              <div className="bg-muted-foreground/15 h-0.5 w-5 rounded-full" />
                              <div
                                className="h-0.5 w-3 rounded-full"
                                style={{ background: t.accent, opacity: 0.5 }}
                              />
                            </div>
                            <span className="text-muted-foreground text-[10px] leading-tight">
                              {t.label}
                            </span>
                          </button>
                        ))}
                      </div>
                    </PopoverContent>
                  </Popover>

                  {/* ─── Top accent bar (accent-bar style) ─── */}
                  {tpl.style === 'accent-bar' && tpl.topBorder && (
                    <div className="h-1 w-full" style={{ background: tpl.topBorder }} />
                  )}

                  {/* ─── Header Area (centered for all styles) ─── */}
                  <div className="px-6 pb-5 pt-8 text-center">
                    <div
                      className="mb-3 inline-flex h-10 w-10 items-center justify-center rounded-full"
                      style={{ backgroundColor: tpl.accentLight }}
                    >
                      <Check className="h-5 w-5" style={{ color: tpl.accent }} />
                    </div>
                    <h3 className="text-base font-semibold tracking-tight">{businessName}</h3>
                    <p
                      className={cn('mt-1 font-bold tracking-tight', tpl.amountSize)}
                      style={{ color: tpl.accent }}
                    >
                      {formatMoney(total, selectedCurrency)}
                    </p>
                    <p className="text-muted-foreground mt-1 text-xs">
                      Invoice #{invoiceNumber} &middot; Due{' '}
                      {dueDate ? format(dueDate, 'MMM dd, yyyy') : '...'}
                    </p>
                  </div>

                  <Separator className={tpl.separatorClass} />

                  {/* ─── Client + Invoice Details (Collapsible) ── */}
                  <div className="px-6 py-4">
                    <Collapsible open={showPreviewDetails} onOpenChange={setShowPreviewDetails}>
                      <div className="mb-3 flex items-center justify-between">
                        <div>
                          <p className="text-sm font-semibold">
                            {selectedClient?.name || 'Select a customer'}
                          </p>
                          <p className="text-muted-foreground text-xs">
                            {selectedClient?.company || ''}
                          </p>
                        </div>
                        <CollapsibleTrigger asChild>
                          <button className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-xs transition-colors">
                            {showPreviewDetails ? 'Hide' : 'Details'}
                            <ChevronUp
                              className={cn(
                                'h-3 w-3 transition-transform',
                                !showPreviewDetails && 'rotate-180'
                              )}
                            />
                          </button>
                        </CollapsibleTrigger>
                      </div>

                      <CollapsibleContent>
                        <Separator className={cn('mb-4', tpl.separatorClass)} />
                        <div className="space-y-2">
                          {lineItems.length > 0 &&
                            lineItems.map((item) => (
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
                                    {formatMoney(item.rate, selectedCurrency)}
                                    {item.description && (
                                      <span className="text-muted-foreground/70 ml-1.5">
                                        &middot; {item.description}
                                      </span>
                                    )}
                                  </p>
                                </div>
                                <span className="ml-4 text-sm font-medium tabular-nums">
                                  {formatMoney(item.quantity * item.rate, selectedCurrency)}
                                </span>
                              </div>
                            ))}

                          {lineItems.length === 0 && (
                            <p className="text-muted-foreground text-sm italic">
                              No items added yet
                            </p>
                          )}

                          <Separator className={cn('my-4', tpl.separatorClass)} />

                          {discountAmount > 0 && (
                            <div className="mb-3 space-y-2">
                              <div className="flex justify-between text-sm">
                                <span className="text-muted-foreground">Subtotal</span>
                                <span className="tabular-nums">
                                  {formatMoney(subtotal, selectedCurrency)}
                                </span>
                              </div>
                              <div className="flex justify-between text-sm">
                                <span className="text-muted-foreground">Discount</span>
                                <span className="tabular-nums text-green-600">
                                  -{formatMoney(discountAmount, selectedCurrency)}
                                </span>
                              </div>
                            </div>
                          )}
                          {taxAmount > 0 && (
                            <div className="mb-3 flex justify-between text-sm">
                              <span className="text-muted-foreground">
                                Tax ({parsedTaxPercent}%)
                              </span>
                              <span className="tabular-nums">
                                {formatMoney(taxAmount, selectedCurrency)}
                              </span>
                            </div>
                          )}
                          <div
                            className={cn(
                              '-mx-3 flex items-baseline justify-between rounded-lg border-l-2 px-3 py-3',
                              tpl.accentBg
                            )}
                            style={{ borderLeftColor: tpl.accent }}
                          >
                            <span className="text-sm font-semibold">Total Due</span>
                            <span
                              className="text-lg font-bold tabular-nums"
                              style={{ color: tpl.accent }}
                            >
                              {formatMoney(total, selectedCurrency)}
                            </span>
                          </div>
                        </div>
                      </CollapsibleContent>
                    </Collapsible>
                  </div>

                  {/* ─── Memo ─── */}
                  {notes && (
                    <>
                      <Separator className={tpl.separatorClass} />
                      <div className="px-6 py-5">
                        <p className="text-muted-foreground text-sm">{notes}</p>
                      </div>
                    </>
                  )}

                  {/* ─── Download Button ─── */}
                  <div className="px-6 pb-6 pt-2">
                    <DownloadUnavailable className="block w-full">
                      <button
                        disabled
                        className={cn(
                          'flex h-12 w-full items-center justify-center gap-2 rounded-lg text-sm font-medium',
                          tpl.buttonColor,
                          'cursor-not-allowed opacity-50'
                        )}
                      >
                        <Download className="h-4 w-4" />
                        Download Invoice
                      </button>
                    </DownloadUnavailable>
                  </div>

                  {/* ─── Footer ─── */}
                  <div className="px-6 pb-5">
                    <div className="flex items-center justify-center gap-2">
                      <div className="bg-border/40 h-px flex-1" />
                      <p className="text-muted-foreground/50 whitespace-nowrap text-[10px]">
                        Powered by Wolff
                      </p>
                      <div className="bg-border/40 h-px flex-1" />
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* ═══ INVOICE PDF TAB ═════════════════════ */}
            {previewTab === 'pdf' && (
              <div className="flex flex-1 flex-col items-center p-4">
                {/* Info line */}
                <p className="text-muted-foreground mb-3 w-full text-xs">
                  A4 Preview &middot; {lineItems.length} item{lineItems.length !== 1 ? 's' : ''}
                </p>

                {/* A4 Scaled Preview */}
                <div className="flex w-full flex-1 items-start justify-center overflow-hidden">
                  <div
                    style={{
                      width: '595px',
                      height: '842px',
                      transform: 'scale(var(--pdf-scale, 0.68))',
                      transformOrigin: 'top center',
                    }}
                    className="border-border/40 relative flex-shrink-0 rounded-sm border bg-white shadow-2xl"
                  >
                    {/* Download floating button */}
                    <DownloadUnavailable className="absolute right-2.5 top-2.5 z-20">
                      <button
                        disabled
                        aria-label="Download PDF (available after saving)"
                        className="bg-muted/80 flex h-7 w-7 cursor-not-allowed items-center justify-center rounded-full opacity-50"
                      >
                        <Download className="text-muted-foreground h-3.5 w-3.5" />
                      </button>
                    </DownloadUnavailable>

                    {/* A4 Page Content */}
                    <div
                      className="flex h-full w-full flex-col text-black"
                      style={{ fontFamily: 'system-ui, sans-serif' }}
                    >
                      {/* Top accent bar */}
                      {tpl.topBorder && (
                        <div
                          className="w-full"
                          style={{ height: '4px', background: tpl.topBorder }}
                        />
                      )}

                      {/* Header */}
                      <div className="flex items-start justify-between px-10 pb-6 pt-8">
                        <div>
                          <h2 className="text-xl font-bold" style={{ color: '#111' }}>
                            {businessName}
                          </h2>
                          <p className="mt-1 text-xs" style={{ color: '#666' }}>
                            hello@company.com
                          </p>
                        </div>
                        <div className="text-right">
                          <h1
                            className="text-2xl font-bold tracking-tight"
                            style={{ color: tpl.accent }}
                          >
                            INVOICE
                          </h1>
                          <p className="mt-1 text-xs" style={{ color: '#666' }}>
                            #{invoiceNumber}
                          </p>
                          <p className="text-xs" style={{ color: '#666' }}>
                            Date: {dueDate ? format(dueDate, 'MMM dd, yyyy') : 'Not set'}
                          </p>
                        </div>
                      </div>

                      {/* Bill To */}
                      <div className="px-10 pb-6">
                        <p
                          className="mb-1 text-[10px] font-semibold uppercase tracking-wider"
                          style={{ color: '#999' }}
                        >
                          Bill To
                        </p>
                        <p className="text-sm font-medium" style={{ color: '#111' }}>
                          {selectedClient?.name || 'Customer Name'}
                        </p>
                        {selectedClient?.company && (
                          <p className="text-xs" style={{ color: '#666' }}>
                            {selectedClient.company}
                          </p>
                        )}
                      </div>

                      {/* Line Items Table */}
                      <div className="flex-1 px-10">
                        <table className="w-full text-xs">
                          <thead>
                            <tr style={{ borderBottom: '2px solid #e5e7eb' }}>
                              <th
                                className="py-2 text-left font-semibold"
                                style={{ color: '#333', width: '50%' }}
                              >
                                Description
                              </th>
                              <th
                                className="py-2 text-center font-semibold"
                                style={{ color: '#333' }}
                              >
                                Qty
                              </th>
                              <th
                                className="py-2 text-right font-semibold"
                                style={{ color: '#333' }}
                              >
                                Rate
                              </th>
                              <th
                                className="py-2 text-right font-semibold"
                                style={{ color: '#333' }}
                              >
                                Amount
                              </th>
                            </tr>
                          </thead>
                          <tbody>
                            {lineItems.length > 0 ? (
                              lineItems.map((item) => (
                                <tr key={item.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                                  <td className="py-2">
                                    <p className="font-medium" style={{ color: '#111' }}>
                                      {item.name || 'Untitled'}
                                    </p>
                                    {item.description && (
                                      <p style={{ color: '#888' }}>{item.description}</p>
                                    )}
                                  </td>
                                  <td className="py-2 text-center" style={{ color: '#333' }}>
                                    {item.quantity}
                                  </td>
                                  <td
                                    className="py-2 text-right tabular-nums"
                                    style={{ color: '#333' }}
                                  >
                                    {formatMoney(item.rate, selectedCurrency)}
                                  </td>
                                  <td
                                    className="py-2 text-right font-medium tabular-nums"
                                    style={{ color: '#111' }}
                                  >
                                    {formatMoney(item.quantity * item.rate, selectedCurrency)}
                                  </td>
                                </tr>
                              ))
                            ) : (
                              <tr>
                                <td
                                  colSpan={4}
                                  className="py-6 text-center"
                                  style={{ color: '#999' }}
                                >
                                  No items added
                                </td>
                              </tr>
                            )}
                          </tbody>
                        </table>
                      </div>

                      {/* Totals */}
                      <div className="px-10 pb-8">
                        <div className="ml-auto" style={{ width: '200px' }}>
                          <div
                            className="flex justify-between py-1 text-xs"
                            style={{ color: '#666' }}
                          >
                            <span>Subtotal</span>
                            <span className="tabular-nums">
                              {formatMoney(subtotal, selectedCurrency)}
                            </span>
                          </div>
                          {discountAmount > 0 && (
                            <div
                              className="flex justify-between py-1 text-xs"
                              style={{ color: '#22c55e' }}
                            >
                              <span>Discount</span>
                              <span className="tabular-nums">
                                -{formatMoney(discountAmount, selectedCurrency)}
                              </span>
                            </div>
                          )}
                          {taxAmount > 0 && (
                            <div
                              className="flex justify-between py-1 text-xs"
                              style={{ color: '#666' }}
                            >
                              <span>Tax ({parsedTaxPercent}%)</span>
                              <span className="tabular-nums">
                                {formatMoney(taxAmount, selectedCurrency)}
                              </span>
                            </div>
                          )}
                          <div
                            className="flex justify-between py-1 text-xs"
                            style={{ borderTop: '1px solid #e5e7eb', color: '#333' }}
                          >
                            <span className="font-medium">Total</span>
                            <span className="font-medium tabular-nums">
                              {formatMoney(total, selectedCurrency)}
                            </span>
                          </div>
                          <div
                            className="-mx-2 mt-1 flex justify-between rounded px-2 py-2"
                            style={{
                              background: tpl.accentBg.replace('bg-', '').includes('50')
                                ? `${tpl.accent}10`
                                : '#f5f5f5',
                            }}
                          >
                            <span className="text-xs font-bold" style={{ color: '#111' }}>
                              Balance Due
                            </span>
                            <span
                              className="text-sm font-bold tabular-nums"
                              style={{ color: tpl.accent }}
                            >
                              {formatMoney(total, selectedCurrency)}
                            </span>
                          </div>
                        </div>
                      </div>

                      {/* Footer */}
                      {notes && (
                        <div className="px-10 pb-4">
                          <p className="text-[10px]" style={{ color: '#999' }}>
                            {notes}
                          </p>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* ═══ EMAIL PREVIEW TAB ═══════════════════ */}
            {previewTab === 'email' && (
              <div className="flex-1 p-4">
                <div
                  className={cn(
                    'bg-card relative overflow-hidden border shadow-sm transition-all duration-300',
                    tpl.cardClass
                  )}
                >
                  {/* ─── Top accent ─── */}
                  {tpl.topBorder && (
                    <div className="h-1 w-full" style={{ background: tpl.topBorder }} />
                  )}

                  {/* ─── Email Header ─── */}
                  <div className="px-6 pb-4 pt-6">
                    <div className="flex items-start justify-between">
                      <div>
                        <h3 className="text-lg font-bold tracking-tight">{businessName}</h3>
                      </div>
                      <div className="text-right">
                        <p className="text-muted-foreground text-xs">{businessName}</p>
                        <p className="mt-0.5 text-lg font-bold" style={{ color: tpl.accent }}>
                          Invoice
                        </p>
                        <p className="text-muted-foreground mt-0.5 text-xs">
                          Due {dueDate ? format(dueDate, 'MMM dd, yyyy') : '...'}
                        </p>
                      </div>
                    </div>
                  </div>

                  {/* ─── CTA Buttons (like Bloom) ─── */}
                  <div className="flex gap-3 px-6 pb-4">
                    <button
                      className={cn(
                        'flex h-11 flex-1 items-center justify-center gap-2 rounded-lg text-sm font-medium transition-colors',
                        tpl.buttonColor
                      )}
                    >
                      Pay this Invoice
                    </button>
                    <button className="border-border hover:bg-muted flex h-11 flex-1 items-center justify-center gap-2 rounded-lg border text-sm font-medium transition-colors">
                      Download PDF
                    </button>
                  </div>

                  <Separator className={tpl.separatorClass} />

                  {/* ─── Invoice Summary ─── */}
                  <div className="space-y-3 px-6 py-4">
                    <p className="text-sm font-medium">Invoice #{invoiceNumber}</p>

                    {/* Line Items */}
                    {lineItems.length > 0 && (
                      <div className="space-y-1">
                        {lineItems.map((item) => (
                          <div
                            key={item.id}
                            className="flex items-center justify-between py-1.5 text-sm"
                          >
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-sm font-medium">
                                {item.name || 'Untitled Item'}
                              </p>
                              <p className="text-muted-foreground truncate text-xs">
                                {item.quantity} &times; {formatMoney(item.rate, selectedCurrency)}
                                {item.description && (
                                  <span className="text-muted-foreground/70 ml-1.5">
                                    &middot; {item.description}
                                  </span>
                                )}
                              </p>
                            </div>
                            <span className="ml-4 text-sm font-medium tabular-nums">
                              {formatMoney(item.quantity * item.rate, selectedCurrency)}
                            </span>
                          </div>
                        ))}
                        <Separator className={tpl.separatorClass} />
                      </div>
                    )}

                    <div className="space-y-2">
                      {discountAmount > 0 && (
                        <>
                          <div className="flex justify-between text-sm">
                            <span className="text-muted-foreground">Subtotal</span>
                            <span className="tabular-nums">
                              {formatMoney(subtotal, selectedCurrency)}
                            </span>
                          </div>
                          <div className="flex justify-between text-sm">
                            <span className="text-muted-foreground">Discount</span>
                            <span className="tabular-nums text-green-600">
                              -{formatMoney(discountAmount, selectedCurrency)}
                            </span>
                          </div>
                          <Separator className={tpl.separatorClass} />
                        </>
                      )}
                      {taxAmount > 0 && (
                        <div className="flex justify-between text-sm">
                          <span className="text-muted-foreground">Tax ({parsedTaxPercent}%)</span>
                          <span className="tabular-nums">
                            {formatMoney(taxAmount, selectedCurrency)}
                          </span>
                        </div>
                      )}
                      <div className="flex justify-between text-sm font-semibold">
                        <span>Total Due</span>
                        <span className="tabular-nums" style={{ color: tpl.accent }}>
                          {formatMoney(total, selectedCurrency)}
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* ─── Memo ─── */}
                  {notes && (
                    <>
                      <Separator className={tpl.separatorClass} />
                      <div className="px-6 py-4">
                        <p className="text-muted-foreground text-sm italic">{notes}</p>
                        <p className="text-muted-foreground mt-1 text-xs">
                          Contact us at <span className="underline">hello@company.com</span>
                        </p>
                      </div>
                    </>
                  )}

                  {/* ─── Legal Footer ─── */}
                  <div className="bg-muted/30 border-t px-6 py-4">
                    <p className="text-muted-foreground text-[10px] leading-relaxed">
                      This email and any attachments are intended solely for the use of the
                      individual or entity to whom they are addressed. If you have received this
                      message in error, please notify {businessName} immediately.
                    </p>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
