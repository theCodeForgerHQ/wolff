'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { formatFullCurrency } from '@/lib/dashboard/chart-utils';
import type { GstSummary } from '@/lib/dashboard/types';

interface GstSummaryCardProps {
  data: GstSummary | null;
  currency?: string;
}

export function GstSummaryCard({ data, currency = 'INR' }: GstSummaryCardProps) {
  return (
    <Card data-testid="gst-summary-card">
      <CardHeader className="pb-2">
        <CardTitle className="text-base font-medium">GST Outward Supplies</CardTitle>
        <CardDescription className="text-xs">Taxable value and tax amounts</CardDescription>
      </CardHeader>
      <CardContent>
        {data ? (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground text-sm">Taxable value</span>
              <span className="font-medium">{formatFullCurrency(data.taxableValue, currency)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground text-sm">CGST</span>
              <span className="font-medium">{formatFullCurrency(data.cgstAmount, currency)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground text-sm">SGST</span>
              <span className="font-medium">{formatFullCurrency(data.sgstAmount, currency)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground text-sm">IGST</span>
              <span className="font-medium">{formatFullCurrency(data.igstAmount, currency)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground text-sm">CESS</span>
              <span className="font-medium">{formatFullCurrency(data.cessAmount, currency)}</span>
            </div>
            <div className="text-muted-foreground border-t pt-2 text-xs">
              {data.invoiceCount} invoice line{data.invoiceCount === 1 ? '' : 's'}
            </div>
          </div>
        ) : (
          <p className="text-muted-foreground text-sm">No GST data available</p>
        )}
      </CardContent>
    </Card>
  );
}
