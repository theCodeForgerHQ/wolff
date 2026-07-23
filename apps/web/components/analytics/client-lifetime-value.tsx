'use client';

import { useMemo } from 'react';
import { ArrowUpRight, ArrowDownRight } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

interface ClientLTV {
  id: string;
  name: string;
  email?: string;
  ltv: number;
  growth?: number;
  isGrowing?: boolean;
}

interface ClientLifetimeValueCardProps {
  data?: ClientLTV[];
  currency?: string;
}

function formatCurrency(amount: number, currency: string = 'USD'): string {
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

export function ClientLifetimeValueCard({
  data: propData,
  currency = 'USD',
}: ClientLifetimeValueCardProps) {
  const { clientData, averageLTV } = useMemo(() => {
    if (!propData || propData.length === 0) {
      return { clientData: [], averageLTV: 0 };
    }
    const avg = propData.reduce((sum, c) => sum + c.ltv, 0) / propData.length;
    return { clientData: propData, averageLTV: avg };
  }, [propData]);

  if (clientData.length === 0) {
    return (
      <Card>
        <CardHeader className="pb-4">
          <CardTitle className="text-sm font-medium">Client Lifetime Value</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-muted-foreground flex h-[200px] items-center justify-center text-sm">
            No client LTV data available
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-4">
        <div className="flex items-baseline justify-between">
          <CardTitle className="text-sm font-medium">Client Lifetime Value</CardTitle>
          <span className="text-muted-foreground text-xs">
            Avg {formatCurrency(averageLTV, currency)}
          </span>
        </div>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          {clientData.map((client) => {
            const initials = client.name
              .split(' ')
              .map((n) => n[0])
              .join('')
              .toUpperCase()
              .slice(0, 2);

            return (
              <div key={client.id} className="flex items-center gap-3">
                <div className="bg-primary/10 text-primary flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-medium">
                  {initials}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{client.name}</p>
                  {client.email && (
                    <p className="text-muted-foreground truncate text-xs">{client.email}</p>
                  )}
                </div>
                <div className="shrink-0 text-right">
                  <p className="text-sm font-medium tabular-nums">
                    {formatCurrency(client.ltv, currency)}
                  </p>
                  {client.growth !== undefined && (
                    <span
                      className={`inline-flex items-center gap-0.5 text-[10px] font-medium ${
                        client.isGrowing !== false
                          ? 'text-emerald-600 dark:text-emerald-400'
                          : 'text-red-600 dark:text-red-400'
                      }`}
                    >
                      {client.isGrowing !== false ? (
                        <ArrowUpRight className="h-2.5 w-2.5" />
                      ) : (
                        <ArrowDownRight className="h-2.5 w-2.5" />
                      )}
                      {Math.abs(client.growth ?? 0)}%
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
