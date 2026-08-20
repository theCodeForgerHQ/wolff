'use client';

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import Link from 'next/link';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { readSseEvents } from '@/lib/assistant/sse';

/**
 * The assistant slide-over: questions stream through
 * /api/assistant/chat as server-sent events; "Draft a quote" calls the
 * quote agent and links the draft to the builder. Answers are rendered as
 * plain text, never as HTML.
 */

interface Citation {
  n: number;
  source_type: string;
  source_id: string;
  label: string;
}

interface Message {
  id: number;
  role: 'user' | 'assistant';
  text: string;
  status?: string;
  citations: Citation[];
}

interface DraftLine {
  name: string;
  qty: number;
  rate: number;
}

interface DraftResult {
  quoteNumber: string;
  builderUrl: string;
  warnings?: string[];
  draft: { title: string; currency: string; line_items: DraftLine[]; assumptions?: string[] };
}

const TOOL_STATUS: Record<string, string> = {
  search_documents: 'Searching your documents…',
  list_overdue_invoices: 'Looking up overdue invoices…',
  receivables_ageing: 'Checking receivables…',
  top_debtors: 'Checking who owes you…',
  gst_summary: 'Summing GST…',
  list_leads: 'Looking up leads…',
  list_deals: 'Looking up deals…',
  get_invoice: 'Opening the invoice…',
};

const CHAT_ERRORS: Record<string, string> = {
  ai_budget_exceeded: "You've reached today's daily AI budget. Try again tomorrow.",
  ai_unavailable: 'The assistant is busy. Try again in a moment.',
  ai_timeout: 'That took too long. Try again.',
};

const DRAFT_ERRORS: Record<string, string> = {
  unknown_client: "I couldn't find that client in this workspace.",
  unknown_rate_card: "The draft cited a rate card that doesn't exist.",
  invalid_output: "The draft wasn't valid. Try rephrasing the brief.",
  api_unavailable: "The quote couldn't be saved. Try again.",
};

const GENERIC_ERROR = 'Something went wrong.';

function citationHref(citation: Citation): string {
  switch (citation.source_type) {
    case 'quote':
      return `/quotes/${citation.source_id}`;
    case 'invoice':
      return `/invoices/${citation.source_id}`;
    case 'client_note':
      return `/clients/${citation.source_id}`;
    default:
      return '/contracts';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function AssistantPanel({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const reduceMotion = useReducedMotion();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const [lastQuestion, setLastQuestion] = useState<string | null>(null);
  const sessionId = useRef<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const nextId = useRef(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const [brief, setBrief] = useState('');
  const [drafting, setDrafting] = useState(false);
  const [draft, setDraft] = useState<DraftResult | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => () => abort.current?.abort(), []);

  function updateLast(change: (message: Message) => Message) {
    setMessages((current) => {
      const last = current[current.length - 1];
      if (!last || last.role !== 'assistant') return current;
      return [...current.slice(0, -1), change(last)];
    });
  }

  async function ask(question: string) {
    const text = question.trim();
    if (!text || streaming) return;
    setChatError(null);
    setLastQuestion(text);
    setMessages((current) => [
      ...current,
      { id: nextId.current++, role: 'user', text, citations: [] },
      { id: nextId.current++, role: 'assistant', text: '', citations: [] },
    ]);
    const controller = new AbortController();
    abort.current = controller;
    setStreaming(true);
    try {
      const response = await fetch('/api/assistant/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          message: text,
          ...(sessionId.current ? { sessionId: sessionId.current } : {}),
        }),
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        setChatError(GENERIC_ERROR);
        return;
      }
      for await (const { event, data } of readSseEvents(response.body)) {
        const payload = isRecord(data) ? data : {};
        if ((event === 'session' || event === 'done') && typeof payload.sessionId === 'string') {
          sessionId.current = payload.sessionId;
        } else if (event === 'tool_call') {
          const name = String(payload.name ?? '');
          updateLast((m) => ({ ...m, status: TOOL_STATUS[name] ?? 'Working…' }));
        } else if (event === 'token') {
          updateLast((m) => ({ ...m, text: m.text + String(payload.text ?? '') }));
        } else if (event === 'citation') {
          const citation = payload as unknown as Citation;
          updateLast((m) => ({ ...m, citations: [...m.citations, citation] }));
        } else if (event === 'error') {
          setChatError(CHAT_ERRORS[String(payload.code)] ?? GENERIC_ERROR);
        }
      }
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        setChatError(GENERIC_ERROR);
      }
    } finally {
      setStreaming(false);
      abort.current = null;
    }
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const question = input;
    setInput('');
    void ask(question);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      const question = input;
      setInput('');
      void ask(question);
    }
  }

  async function onDraft(event: FormEvent) {
    event.preventDefault();
    if (!brief.trim() || drafting) return;
    setDrafting(true);
    setDraft(null);
    setDraftError(null);
    try {
      const response = await fetch('/api/assistant/drafts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ brief: brief.trim() }),
      });
      const json: unknown = await response.json().catch(() => null);
      if (isRecord(json) && json.success === true && isRecord(json.data)) {
        setDraft(json.data as unknown as DraftResult);
      } else {
        const code = isRecord(json) && isRecord(json.error) ? String(json.error.code) : '';
        setDraftError(DRAFT_ERRORS[code] ?? GENERIC_ERROR);
      }
    } catch {
      setDraftError(GENERIC_ERROR);
    } finally {
      setDrafting(false);
    }
  }

  const enter = reduceMotion ? { opacity: 1 } : { opacity: 0, y: 6 };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col gap-4 sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Assistant</SheetTitle>
          <SheetDescription>Answers from your own quotes, invoices and contracts.</SheetDescription>
        </SheetHeader>
        <Tabs defaultValue="ask" className="flex min-h-0 flex-1 flex-col">
          <TabsList className="self-start">
            <TabsTrigger value="ask">Ask</TabsTrigger>
            <TabsTrigger value="draft">Draft a quote</TabsTrigger>
          </TabsList>

          <TabsContent value="ask" className="flex min-h-0 flex-1 flex-col gap-3">
            <div
              role="log"
              aria-live="polite"
              className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1"
            >
              <AnimatePresence initial={false}>
                {messages.map((message) => (
                  <motion.div
                    key={message.id}
                    initial={enter}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: reduceMotion ? 0 : 0.18 }}
                    className={
                      message.role === 'user'
                        ? 'bg-primary text-primary-foreground ml-8 rounded-lg px-3 py-2 text-sm'
                        : 'bg-muted mr-8 rounded-lg px-3 py-2 text-sm'
                    }
                  >
                    {message.status && !message.text && (
                      <p className="text-muted-foreground text-xs">{message.status}</p>
                    )}
                    {message.role === 'assistant' && streaming && !message.text && (
                      <span aria-label="Assistant is typing" className="inline-flex gap-1">
                        {[0, 1, 2].map((dot) => (
                          <motion.span
                            key={dot}
                            className="bg-muted-foreground inline-block h-1.5 w-1.5 rounded-full"
                            animate={reduceMotion ? undefined : { opacity: [0.3, 1, 0.3] }}
                            transition={{ duration: 1, repeat: Infinity, delay: dot * 0.2 }}
                          />
                        ))}
                      </span>
                    )}
                    {message.text && <p className="whitespace-pre-wrap">{message.text}</p>}
                    {message.status && message.text && (
                      <p className="text-muted-foreground mt-1 text-xs">{message.status}</p>
                    )}
                    {message.citations.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1">
                        {message.citations.map((citation) => (
                          <Link
                            key={`${citation.n}-${citation.source_id}`}
                            href={citationHref(citation)}
                            className="bg-background hover:bg-accent focus-visible:ring-ring rounded border px-1.5 py-0.5 text-xs focus-visible:outline-none focus-visible:ring-2"
                          >
                            {`[${citation.n}] ${citation.label}`}
                          </Link>
                        ))}
                      </div>
                    )}
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>
            {chatError && (
              <div
                role="alert"
                className="border-destructive/40 text-destructive flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm"
              >
                <span>{chatError}</span>
                {lastQuestion && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setMessages((current) => current.slice(0, -2));
                      void ask(lastQuestion);
                    }}
                  >
                    Retry
                  </Button>
                )}
              </div>
            )}
            <form onSubmit={onSubmit} className="flex items-end gap-2">
              <Textarea
                ref={inputRef}
                aria-label="Ask the assistant"
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={onKeyDown}
                rows={2}
                placeholder="Who owes me most?"
                className="min-h-0 resize-none"
              />
              {streaming ? (
                <Button type="button" variant="outline" onClick={() => abort.current?.abort()}>
                  Stop
                </Button>
              ) : (
                <Button type="submit" disabled={!input.trim()}>
                  Send
                </Button>
              )}
            </form>
          </TabsContent>

          <TabsContent value="draft" className="flex min-h-0 flex-1 flex-col gap-3">
            <form onSubmit={onDraft} className="space-y-2">
              <Textarea
                aria-label="Quote brief"
                value={brief}
                onChange={(event) => setBrief(event.target.value)}
                rows={3}
                placeholder="Draft a quote for Acme Robotics: logo design and a landing page"
              />
              <Button type="submit" disabled={drafting || !brief.trim()}>
                {drafting ? 'Drafting…' : 'Draft'}
              </Button>
            </form>
            {draftError && (
              <p role="alert" className="text-destructive text-sm">
                {draftError}
              </p>
            )}
            {draft && (
              <motion.section
                initial={enter}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: reduceMotion ? 0 : 0.18 }}
                aria-label="Drafted quote"
                className="space-y-2 rounded-lg border p-3 text-sm"
              >
                <div className="flex items-baseline justify-between gap-2">
                  <h3 className="font-medium">{draft.draft.title}</h3>
                  <span className="text-muted-foreground">{draft.quoteNumber}</span>
                </div>
                <ul className="space-y-1">
                  {draft.draft.line_items.map((line, index) => (
                    <li key={`${line.name}-${index}`}>
                      <span>{line.name}</span>
                      <span className="text-muted-foreground">
                        {` × ${line.qty} @ ${draft.draft.currency} ${line.rate}`}
                      </span>
                    </li>
                  ))}
                </ul>
                {(draft.warnings ?? []).map((warning) => (
                  <p key={warning} className="text-amber-700 dark:text-amber-400">
                    {warning}
                  </p>
                ))}
                {(draft.draft.assumptions ?? []).length > 0 && (
                  <ul className="text-muted-foreground list-disc pl-4">
                    {(draft.draft.assumptions ?? []).map((assumption) => (
                      <li key={assumption}>{assumption}</li>
                    ))}
                  </ul>
                )}
                <Button asChild size="sm">
                  <Link href={draft.builderUrl} onClick={() => onOpenChange(false)}>
                    Open in builder
                  </Link>
                </Button>
              </motion.section>
            )}
          </TabsContent>
        </Tabs>
      </SheetContent>
    </Sheet>
  );
}
