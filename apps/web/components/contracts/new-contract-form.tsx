'use client';

import { useState, useMemo, useCallback, useEffect } from 'react';
import { sanitizeHtml } from '@/lib/sanitize';
import { useRouter } from 'next/navigation';
import {
  Loader2,
  FileText,
  ChevronDown,
  Pencil,
  Trash2,
  Download,
  Check,
  PenLine,
  Send,
} from 'lucide-react';
import { format } from 'date-fns';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { Separator } from '@/components/ui/separator';
import { toast } from 'sonner';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Label } from '@/components/ui/label';
import { ContractEditor } from './contract-editor';
import { createContractInstance, getContractTemplateById } from '@/lib/contracts/actions';
import type { ContractTemplateListItem, ContractVariable } from '@/lib/contracts/types';

// Types
interface ClientOption {
  id: string;
  name: string;
  email: string | null;
  company: string | null;
}

interface QuoteOption {
  id: string;
  title: string | null;
}

type PreviewTab = 'contract' | 'email' | 'pdf';

// Main Component
interface NewContractFormProps {
  templates: ContractTemplateListItem[];
  clients: ClientOption[];
  quotes: QuoteOption[];
  preselectedTemplateId?: string;
  preselectedClientId?: string;
}

export default function NewContractForm({
  templates,
  clients,
  quotes,
  preselectedTemplateId,
  preselectedClientId,
}: NewContractFormProps) {
  const router = useRouter();
  // toast from sonner (imported at top level)
  const [loading, setLoading] = useState(false);

  // Form State
  const [selectedTemplateId, setSelectedTemplateId] = useState(preselectedTemplateId || '');
  const [selectedClientId, setSelectedClientId] = useState(preselectedClientId || '');
  const [selectedQuoteId, setSelectedQuoteId] = useState('');
  const [variableValues, setVariableValues] = useState<Record<string, string>>({});
  const [contractContent, setContractContent] = useState('');

  // UI State
  const [previewTab, setPreviewTab] = useState<PreviewTab>('contract');

  // Derived state
  const selectedClient = useMemo(
    () => clients.find((c) => c.id === selectedClientId),
    [clients, selectedClientId]
  );

  const selectedTemplate = useMemo(
    () => templates.find((t) => t.id === selectedTemplateId),
    [templates, selectedTemplateId]
  );

  // Fetch template content when template changes
  useEffect(() => {
    if (!selectedTemplateId) {
      setContractContent('');
      return;
    }
    getContractTemplateById(selectedTemplateId).then((detail) => {
      if (detail) {
        setContractContent(detail.content);
        // Initialize variable defaults
        const defaults: Record<string, string> = {};
        detail.variables.forEach((v) => {
          if (v.defaultValue) defaults[v.key] = v.defaultValue;
        });
        setVariableValues(defaults);
      }
    });
  }, [selectedTemplateId]);

  // Replace variable placeholders in content for preview
  const previewContent = useMemo(() => {
    let content = contractContent;
    if (selectedTemplate) {
      for (const v of selectedTemplate.variables) {
        const value = variableValues[v.key] || `[${v.label}]`;
        content = content.replace(new RegExp(`\\{\\{${v.key}\\}\\}`, 'g'), value);
      }
    }
    return content;
  }, [contractContent, selectedTemplate, variableValues]);

  const businessName = 'Your Business';

  // Handlers
  const handleTemplateChange = (templateId: string) => {
    setSelectedTemplateId(templateId);
  };

  const handleSubmit = async (isDraft: boolean) => {
    if (!selectedTemplateId || !selectedClientId) {
      toast.error('Please select a template and a signee.');
      return;
    }

    // Validate required variables
    if (selectedTemplate) {
      const missing = selectedTemplate.variables
        .filter((v) => v.required && !variableValues[v.key]?.trim())
        .map((v) => v.label);
      if (missing.length > 0) {
        toast.error(`Please fill in: ${missing.join(', ')}`);
        return;
      }
    }

    setLoading(true);
    try {
      // Bug #186: Pass sendImmediately flag based on isDraft
      const instance = await createContractInstance({
        contractId: selectedTemplateId,
        clientId: selectedClientId,
        quoteId: selectedQuoteId || undefined,
        variableValues,
        sendImmediately: !isDraft,
      });
      toast.success(
        isDraft
          ? 'Contract saved as a draft.'
          : `Contract sent to ${selectedClient?.name || 'the client'}.`
      );
      router.push(`/contracts/${instance.id}`);
    } catch {
      toast.error('Failed to create contract.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex h-[calc(100vh-64px)] flex-col">
      {/* Main Content */}
      <div className="flex-1 overflow-hidden">
        <div className="grid h-full lg:grid-cols-[1fr_420px] xl:grid-cols-[1fr_480px]">
          {/* LEFT PANEL -- Editor */}
          <div className="bg-background overflow-y-auto border-r">
            <div className="mx-auto max-w-[640px] space-y-0 px-8 py-10">
              {/* Contract Details Section */}
              <div className="pb-8">
                <h3 className="font-display mb-6 text-xl font-semibold tracking-tight">
                  Contract Details
                </h3>

                {/* Template Selector */}
                <div className="mb-5 space-y-1.5">
                  <Label className="text-muted-foreground text-xs">Contract Template</Label>
                  <Select value={selectedTemplateId} onValueChange={handleTemplateChange}>
                    <SelectTrigger className="h-11">
                      <SelectValue placeholder="Select a contract template" />
                    </SelectTrigger>
                    <SelectContent>
                      {templates.map((template) => (
                        <SelectItem key={template.id} value={template.id}>
                          <div className="flex items-center gap-2">
                            <FileText className="text-muted-foreground h-3.5 w-3.5" />
                            <span>{template.name}</span>
                            <span className="text-muted-foreground text-xs">
                              ({template.instanceCount} used)
                            </span>
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {/* Client / Signee Selector */}
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
                          {selectedClient.email && (
                            <p className="text-muted-foreground text-xs">{selectedClient.email}</p>
                          )}
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
                      <Label className="text-muted-foreground text-xs">Signee</Label>
                      <Select value={selectedClientId} onValueChange={setSelectedClientId}>
                        <SelectTrigger className="h-11">
                          <SelectValue placeholder="Select a signee" />
                        </SelectTrigger>
                        <SelectContent>
                          {clients.map((client) => (
                            <SelectItem key={client.id} value={client.id}>
                              <div className="flex items-center gap-2">
                                <span>{client.name}</span>
                                {client.company && (
                                  <span className="text-muted-foreground text-xs">
                                    {client.company}
                                  </span>
                                )}
                              </div>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                </div>

                {/* Related Quote (Optional) */}
                <div className="space-y-1.5">
                  <Label className="text-muted-foreground text-xs">Related Quote (Optional)</Label>
                  <Select
                    value={selectedQuoteId || 'none'}
                    onValueChange={(v) => setSelectedQuoteId(v === 'none' ? '' : v)}
                  >
                    <SelectTrigger className="h-11">
                      <SelectValue placeholder="No linked quote" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">No linked quote</SelectItem>
                      {quotes.map((quote) => (
                        <SelectItem key={quote.id} value={quote.id}>
                          {quote.title || 'Untitled Quote'}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <Separator className="bg-border/60" />

              {/* Variables Section */}
              {selectedTemplate && selectedTemplate.variables.length > 0 && (
                <div className="py-8">
                  <h3 className="font-display mb-2 text-xl font-semibold tracking-tight">
                    Contract Variables
                  </h3>
                  <p className="text-muted-foreground mb-5 text-[13px]">
                    Fill in the values for this contract&apos;s merge fields.
                  </p>

                  <div className="space-y-4">
                    {selectedTemplate.variables.map((variable) => (
                      <div key={variable.key} className="space-y-1.5">
                        <Label className="text-muted-foreground text-xs">
                          {variable.label}
                          {variable.required && <span className="text-destructive ml-1">*</span>}
                        </Label>
                        {variable.type === 'boolean' ? (
                          <Select
                            value={variableValues[variable.key] || variable.defaultValue || 'false'}
                            onValueChange={(value) =>
                              setVariableValues((prev) => ({ ...prev, [variable.key]: value }))
                            }
                          >
                            <SelectTrigger className="h-10">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="true">Yes</SelectItem>
                              <SelectItem value="false">No</SelectItem>
                            </SelectContent>
                          </Select>
                        ) : (
                          <Input
                            type={
                              variable.type === 'date'
                                ? 'date'
                                : variable.type === 'number'
                                  ? 'number'
                                  : 'text'
                            }
                            value={variableValues[variable.key] || ''}
                            onChange={(e) =>
                              setVariableValues((prev) => ({
                                ...prev,
                                [variable.key]: e.target.value,
                              }))
                            }
                            className="h-10"
                            placeholder={
                              variable.defaultValue || `Enter ${variable.label.toLowerCase()}`
                            }
                          />
                        )}
                      </div>
                    ))}
                  </div>

                  <Separator className="bg-border/60 mt-8" />
                </div>
              )}

              {/* Contract Content Editor */}
              {selectedTemplateId && contractContent && (
                <div className="py-8">
                  <h3 className="font-display mb-2 text-xl font-semibold tracking-tight">
                    Contract Content
                  </h3>
                  <p className="text-muted-foreground mb-5 text-[13px]">
                    Edit the contract content or leave as-is from the template.
                  </p>
                  <ContractEditor
                    key={selectedTemplateId}
                    content={contractContent}
                    onChange={setContractContent}
                    variables={selectedTemplate?.variables}
                  />
                </div>
              )}

              {/* Bottom Action Bar */}
              <div className="flex items-center gap-3 border-t pb-8 pt-4">
                <Button
                  onClick={() => handleSubmit(false)}
                  disabled={loading || !selectedTemplateId || !selectedClientId}
                  size="lg"
                  className="px-8"
                >
                  {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  <Send className="mr-2 h-4 w-4" />
                  Send Contract
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

          {/* RIGHT PANEL -- Live Preview */}
          <div className="bg-muted/30 flex flex-col overflow-y-auto">
            {/* Preview Tabs */}
            <div className="bg-background/95 supports-backdrop-filter:bg-background/60 sticky top-0 z-10 border-b px-4 pb-3 pt-4 backdrop-blur-sm">
              <Tabs value={previewTab} onValueChange={(v) => setPreviewTab(v as PreviewTab)}>
                <TabsList className="grid h-10 w-full grid-cols-3">
                  <TabsTrigger
                    value="contract"
                    className="data-[state=active]:text-foreground text-xs"
                  >
                    Contract Page
                  </TabsTrigger>
                  <TabsTrigger
                    value="email"
                    className="data-[state=active]:text-foreground text-xs"
                  >
                    Email Preview
                  </TabsTrigger>
                  <TabsTrigger value="pdf" className="data-[state=active]:text-foreground text-xs">
                    Contract PDF
                  </TabsTrigger>
                </TabsList>
              </Tabs>
            </div>

            {/* CONTRACT PAGE TAB */}
            {previewTab === 'contract' && (
              <div className="flex-1 p-4">
                <div className="bg-card relative overflow-hidden rounded-2xl border shadow-sm">
                  {/* Header */}
                  <div className="px-6 pb-5 pt-8 text-center">
                    <div className="bg-primary/10 mb-3 inline-flex h-10 w-10 items-center justify-center rounded-full">
                      <FileText className="text-primary h-5 w-5" />
                    </div>
                    <h3 className="text-base font-semibold tracking-tight">{businessName}</h3>
                    <p className="text-primary mt-1 text-lg font-bold tracking-tight">
                      {selectedTemplate?.name || 'Select a Template'}
                    </p>
                    <p className="text-muted-foreground mt-1 text-xs">
                      {selectedClient ? `Prepared for ${selectedClient.name}` : 'Select a signee'}
                      {' \u00B7 '}
                      {format(new Date(), 'MMM dd, yyyy')}
                    </p>
                  </div>

                  <Separator />

                  {/* Contract Body Preview */}
                  <div className="px-6 py-5">
                    {previewContent ? (
                      <div
                        className="prose prose-sm [&_strong]:text-foreground max-h-[400px] max-w-none overflow-y-auto text-sm [&_h2]:mb-2 [&_h2]:mt-4 [&_h2]:text-base [&_h2]:font-semibold [&_h3]:mb-1 [&_h3]:mt-3 [&_h3]:text-sm [&_h3]:font-semibold"
                        dangerouslySetInnerHTML={{ __html: sanitizeHtml(previewContent) }}
                      />
                    ) : (
                      <div className="py-12 text-center">
                        <FileText className="text-muted-foreground mx-auto mb-3 h-8 w-8" />
                        <p className="text-muted-foreground text-sm">
                          Select a contract template to see the preview
                        </p>
                      </div>
                    )}
                  </div>

                  <Separator />

                  {/* Signature Area */}
                  <div className="px-6 py-5">
                    <div className="mb-4 flex items-center gap-3">
                      <PenLine className="text-muted-foreground h-4 w-4" />
                      <span className="text-sm font-medium">Signature</span>
                    </div>
                    <div className="bg-muted/10 rounded-lg border-2 border-dashed p-6 text-center">
                      <p className="text-muted-foreground text-sm">
                        {selectedClient?.name || 'Signee'} will sign here
                      </p>
                      <p className="text-muted-foreground mt-1 text-xs">Draw or type signature</p>
                    </div>
                  </div>

                  {/* Action Button */}
                  <div className="px-6 pb-6 pt-2">
                    <button className="bg-primary text-primary-foreground flex h-12 w-full items-center justify-center gap-2 rounded-lg text-sm font-medium">
                      <PenLine className="h-4 w-4" />
                      Sign Contract
                    </button>
                  </div>

                  {/* Footer */}
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
            )}

            {/* EMAIL PREVIEW TAB */}
            {previewTab === 'email' && (
              <div className="flex-1 p-4">
                <div className="bg-card relative overflow-hidden rounded-2xl border shadow-sm">
                  {/* Email Header */}
                  <div className="px-6 pb-4 pt-6">
                    <div className="flex items-start justify-between">
                      <div>
                        <h3 className="text-lg font-bold tracking-tight">{businessName}</h3>
                      </div>
                      <div className="text-right">
                        <p className="text-muted-foreground text-xs">{businessName}</p>
                        <p className="text-primary mt-0.5 text-lg font-bold">Contract</p>
                        <p className="text-muted-foreground mt-0.5 text-xs">
                          {format(new Date(), 'MMM dd, yyyy')}
                        </p>
                      </div>
                    </div>
                  </div>

                  {/* CTA Buttons */}
                  <div className="flex gap-3 px-6 pb-4">
                    <button className="bg-primary text-primary-foreground flex h-11 flex-1 items-center justify-center gap-2 rounded-lg text-sm font-medium">
                      View & Sign Contract
                    </button>
                    <button className="border-border hover:bg-muted flex h-11 flex-1 items-center justify-center gap-2 rounded-lg border text-sm font-medium transition-colors">
                      Download PDF
                    </button>
                  </div>

                  <Separator />

                  {/* Contract Summary */}
                  <div className="space-y-3 px-6 py-4">
                    <p className="text-sm font-medium">{selectedTemplate?.name || 'Contract'}</p>
                    <p className="text-muted-foreground text-sm">
                      Hi {selectedClient?.name || '[Client Name]'},
                    </p>
                    <p className="text-muted-foreground text-sm">
                      Please review and sign the attached contract at your earliest convenience.
                      Click the button above to view the full contract and add your signature.
                    </p>
                    {selectedTemplate?.variables && selectedTemplate.variables.length > 0 && (
                      <>
                        <Separator />
                        <div>
                          <p className="text-muted-foreground mb-2 text-xs font-medium uppercase tracking-wider">
                            Key Details
                          </p>
                          <div className="space-y-1.5">
                            {selectedTemplate.variables.slice(0, 4).map((v) => (
                              <div key={v.key} className="flex justify-between text-sm">
                                <span className="text-muted-foreground">{v.label}</span>
                                <span className="font-medium">
                                  {variableValues[v.key] || '\u2014'}
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>
                      </>
                    )}
                  </div>

                  <Separator />

                  {/* Legal Footer */}
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

            {/* CONTRACT PDF TAB */}
            {previewTab === 'pdf' && (
              <div className="flex flex-1 flex-col items-center p-4">
                <p className="text-muted-foreground mb-3 w-full text-xs">
                  A4 Preview · {selectedTemplate?.name || 'No template selected'}
                </p>

                <div className="flex w-full flex-1 items-start justify-center overflow-hidden">
                  <div
                    style={{
                      width: '595px',
                      height: '842px',
                      transform: 'scale(var(--pdf-scale, 0.68))',
                      transformOrigin: 'top center',
                    }}
                    className="border-border/40 relative shrink-0 rounded-sm border bg-white shadow-2xl"
                  >
                    <div
                      className="flex h-full w-full flex-col overflow-hidden text-black"
                      style={{ fontFamily: 'system-ui, sans-serif' }}
                    >
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
                            style={{ color: '#3786b3' }}
                          >
                            CONTRACT
                          </h1>
                          <p className="mt-1 text-xs" style={{ color: '#666' }}>
                            {format(new Date(), 'MMM dd, yyyy')}
                          </p>
                        </div>
                      </div>

                      {/* Prepared For */}
                      <div className="px-10 pb-4">
                        <p
                          className="mb-1 text-[10px] font-semibold uppercase tracking-wider"
                          style={{ color: '#999' }}
                        >
                          Prepared For
                        </p>
                        <p className="text-sm font-medium" style={{ color: '#111' }}>
                          {selectedClient?.name || 'Client Name'}
                        </p>
                        {selectedClient?.company && (
                          <p className="text-xs" style={{ color: '#666' }}>
                            {selectedClient.company}
                          </p>
                        )}
                      </div>

                      {/* Contract Title */}
                      <div className="px-10 pb-4">
                        <p className="text-sm font-semibold" style={{ color: '#3786b3' }}>
                          {selectedTemplate?.name || 'Contract'}
                        </p>
                      </div>

                      {/* Content Preview */}
                      <div className="flex-1 overflow-hidden px-10">
                        {previewContent ? (
                          <div
                            className="max-h-[500px] overflow-hidden text-[10px] leading-relaxed"
                            style={{ color: '#333' }}
                            dangerouslySetInnerHTML={{ __html: sanitizeHtml(previewContent) }}
                          />
                        ) : (
                          <p className="py-8 text-center text-xs" style={{ color: '#999' }}>
                            Select a template to preview
                          </p>
                        )}
                      </div>

                      {/* Signature Line */}
                      <div className="px-10 pb-8 pt-4">
                        <div className="flex gap-16">
                          <div className="flex-1">
                            <div className="border-t pt-2" style={{ borderColor: '#ddd' }}>
                              <p className="text-[10px] font-medium" style={{ color: '#333' }}>
                                {selectedClient?.name || 'Client'}
                              </p>
                              <p className="text-[9px]" style={{ color: '#999' }}>
                                Signature / Date
                              </p>
                            </div>
                          </div>
                          <div className="flex-1">
                            <div className="border-t pt-2" style={{ borderColor: '#ddd' }}>
                              <p className="text-[10px] font-medium" style={{ color: '#333' }}>
                                {businessName}
                              </p>
                              <p className="text-[9px]" style={{ color: '#999' }}>
                                Signature / Date
                              </p>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
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
