'use client';

import Link from 'next/link';
import { ArrowUpRight } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { formatCurrency, formatDate } from '@/lib/utils';
import type { RecentQuote, RecentInvoice } from '@/lib/dashboard/types';

interface RecentQuotesProps {
  quotes: RecentQuote[];
  currency?: string;
}

interface RecentInvoicesProps {
  invoices: RecentInvoice[];
  currency?: string;
}

const statusDot: Record<string, string> = {
  draft: 'bg-muted-foreground/40',
  sent: 'bg-blue-500',
  viewed: 'bg-amber-500',
  accepted: 'bg-emerald-500',
  declined: 'bg-red-500',
  expired: 'bg-muted-foreground/30',
  paid: 'bg-emerald-500',
  partial: 'bg-amber-500',
  overdue: 'bg-red-500',
  void: 'bg-muted-foreground/30',
};

export function RecentQuotes({ quotes, currency = 'USD' }: RecentQuotesProps) {
  return (
    <Card className="flex h-full flex-col">
      <CardHeader className="pb-0">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-medium">Recent Quotes</CardTitle>
          <Button variant="ghost" size="sm" className="text-muted-foreground h-7 text-xs" asChild>
            <Link href="/quotes">
              View all
              <ArrowUpRight className="ml-1 h-3 w-3" />
            </Link>
          </Button>
        </div>
      </CardHeader>
      <CardContent className="flex-1 overflow-y-auto pt-3">
        {quotes.length === 0 ? (
          <p className="text-muted-foreground py-6 text-center text-sm">No quotes yet</p>
        ) : (
          <div className="space-y-0">
            {quotes.map((quote) => (
              <Link
                key={quote.id}
                href={`/quotes/${quote.id}`}
                className="hover:bg-muted/40 group -mx-6 flex items-center justify-between border-t px-6 py-2.5 transition-colors first:border-t-0"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <span
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${statusDot[quote.status] || 'bg-muted-foreground/30'}`}
                  />
                  <div className="min-w-0">
                    <p className="group-hover:text-primary truncate text-sm font-medium transition-colors">
                      {quote.title}
                    </p>
                    <p className="text-muted-foreground truncate text-xs">{quote.clientName}</p>
                  </div>
                </div>
                <div className="ml-3 flex shrink-0 items-center gap-3">
                  <span className="text-muted-foreground text-sm tabular-nums">
                    {formatCurrency(quote.total, currency)}
                  </span>
                  <Badge
                    variant="outline"
                    className="px-1.5 py-0 text-[10px] font-normal capitalize"
                  >
                    {quote.status}
                  </Badge>
                </div>
              </Link>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function RecentInvoices({ invoices, currency = 'USD' }: RecentInvoicesProps) {
  return (
    <Card className="flex h-full flex-col">
      <CardHeader className="pb-0">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-medium">Recent Invoices</CardTitle>
          <Button variant="ghost" size="sm" className="text-muted-foreground h-7 text-xs" asChild>
            <Link href="/invoices">
              View all
              <ArrowUpRight className="ml-1 h-3 w-3" />
            </Link>
          </Button>
        </div>
      </CardHeader>
      <CardContent className="flex-1 overflow-y-auto pt-3">
        {invoices.length === 0 ? (
          <p className="text-muted-foreground py-6 text-center text-sm">No invoices yet</p>
        ) : (
          <div className="space-y-0">
            {invoices.map((invoice) => (
              <Link
                key={invoice.id}
                href={`/invoices/${invoice.id}`}
                className="hover:bg-muted/40 group -mx-6 flex items-center justify-between border-t px-6 py-2.5 transition-colors first:border-t-0"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <span
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${statusDot[invoice.status] || 'bg-muted-foreground/30'}`}
                  />
                  <div className="min-w-0">
                    <p className="group-hover:text-primary truncate text-sm font-medium transition-colors">
                      {invoice.invoiceNumber}
                    </p>
                    <p className="text-muted-foreground truncate text-xs">{invoice.clientName}</p>
                  </div>
                </div>
                <div className="ml-3 flex shrink-0 items-center gap-3">
                  <div className="text-right">
                    <span className="text-muted-foreground text-sm tabular-nums">
                      {formatCurrency(invoice.total, currency)}
                    </span>
                  </div>
                  <Badge
                    variant="outline"
                    className="px-1.5 py-0 text-[10px] font-normal capitalize"
                  >
                    {invoice.status}
                  </Badge>
                </div>
              </Link>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
