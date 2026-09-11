'use client';

import { useMemo } from 'react';
import { DateRange } from 'react-day-picker';
import { AlertTriangle, CheckCircle2, Clock } from 'lucide-react';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import type { PaymentAgingData } from '@/lib/dashboard/types';

interface FinancialHealthSectionProps {
  dateRange?: DateRange;
  /**
   * The workspace's base currency. The dashboard's figures are converted to
   * it (lib/dashboard/actions.ts), so there is no default.
   */
  currency: string;
  outstandingAmount: number;
  overdueAmount: number;
  revenueThisMonth: number;
  paymentAging: PaymentAgingData;
}

function formatCurrency(amount: number, currency: string): string {
  const parts = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).formatToParts(amount);
  return parts
    .map((p, i) => {
      if (p.type === 'currency' && parts[i + 1]?.type !== 'literal') return p.value + ' ';
      return p.value;
    })
    .join('');
}

const AGING_BUCKETS_CONFIG = [
  { label: 'Current', color: 'bg-emerald-500', dot: 'bg-emerald-500' },
  { label: '1-30 Days', color: 'bg-amber-400', dot: 'bg-amber-400' },
  { label: '31-60 Days', color: 'bg-orange-500', dot: 'bg-orange-500' },
  { label: '60+ Days', color: 'bg-red-500', dot: 'bg-red-500' },
] as const;

export function FinancialHealthSection({
  outstandingAmount,
  overdueAmount,
  revenueThisMonth,
  paymentAging,
  currency,
}: FinancialHealthSectionProps) {
  const collectionRate =
    outstandingAmount > 0
      ? Math.min(100, (revenueThisMonth / (revenueThisMonth + outstandingAmount)) * 100)
      : 100;

  // Cheap arithmetic: no useMemo (the React Compiler memoizes it anyway).
  const agingBuckets = (() => {
    const total = paymentAging.totalOutstanding || 1;
    return [
      { amount: paymentAging.current, percentage: (paymentAging.current / total) * 100 },
      { amount: paymentAging.days1to30, percentage: (paymentAging.days1to30 / total) * 100 },
      { amount: paymentAging.days31to60, percentage: (paymentAging.days31to60 / total) * 100 },
      {
        amount: paymentAging.days61to90 + paymentAging.days90plus,
        percentage: ((paymentAging.days61to90 + paymentAging.days90plus) / total) * 100,
      },
    ];
  })();

  const healthStatus = useMemo(() => {
    if (outstandingAmount === 0)
      return {
        label: 'Healthy',
        color: 'text-emerald-600 dark:text-emerald-400',
        icon: CheckCircle2,
      };
    const overdueRatio = (overdueAmount / outstandingAmount) * 100;
    if (overdueRatio < 10)
      return {
        label: 'Healthy',
        color: 'text-emerald-600 dark:text-emerald-400',
        icon: CheckCircle2,
      };
    if (overdueRatio < 25) return { label: 'Fair', color: 'text-amber-500', icon: Clock };
    return {
      label: 'Needs Attention',
      color: 'text-red-500 dark:text-red-400',
      icon: AlertTriangle,
    };
  }, [outstandingAmount, overdueAmount]);

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-baseline justify-between">
          <div>
            <CardTitle className="text-sm font-medium">Financial Health</CardTitle>
            <p className="text-muted-foreground text-xs">Amounts in {currency}</p>
          </div>
          <div className={cn('flex items-center gap-1.5 text-xs font-medium', healthStatus.color)}>
            <healthStatus.icon className="h-3 w-3" />
            <span>{healthStatus.label}</span>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {/* Key metrics row */}
        <div className="mb-5 flex items-center gap-6">
          <div>
            <p className="text-2xl font-semibold tracking-tight">
              {formatCurrency(outstandingAmount, currency)}
            </p>
            <p className="text-muted-foreground text-xs">Outstanding</p>
          </div>
          <div className="bg-border h-8 w-px" />
          <div>
            <p className="text-2xl font-semibold tracking-tight text-red-500 dark:text-red-400">
              {formatCurrency(overdueAmount, currency)}
            </p>
            <p className="text-muted-foreground text-xs">Overdue</p>
          </div>
          <div className="bg-border h-8 w-px" />
          <div>
            <p className="text-2xl font-semibold tracking-tight">{collectionRate.toFixed(0)}%</p>
            <p className="text-muted-foreground text-xs">Collection rate</p>
          </div>
        </div>

        {/* Aging breakdown */}
        <div className="space-y-2.5">
          {agingBuckets.map((bucket, i) => {
            const config = AGING_BUCKETS_CONFIG[i]!;
            return (
              <div key={config.label} className="flex items-center gap-3">
                <div className="flex w-20 shrink-0 items-center gap-1.5">
                  <span className={`h-1.5 w-1.5 rounded-full ${config.dot} shrink-0`} />
                  <span className="text-muted-foreground text-xs">{config.label}</span>
                </div>
                <div className="bg-muted h-1.5 flex-1 overflow-hidden rounded-full">
                  <div
                    className={`h-full rounded-full transition-all duration-500 ease-out ${config.color}`}
                    style={{ width: `${Math.max(bucket.percentage, bucket.amount > 0 ? 3 : 0)}%` }}
                  />
                </div>
                <span className="w-14 text-right text-xs font-medium tabular-nums">
                  {formatCurrency(bucket.amount, currency)}
                </span>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
