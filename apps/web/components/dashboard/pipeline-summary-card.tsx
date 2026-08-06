'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { formatFullCurrency } from '@/lib/dashboard/chart-utils';
import type { PipelineStageSummary } from '@/lib/dashboard/types';

interface PipelineSummaryCardProps {
  data: PipelineStageSummary[];
  currency?: string;
}

export function PipelineSummaryCard({ data, currency = 'USD' }: PipelineSummaryCardProps) {
  const totalValue = data.reduce((sum, s) => sum + s.totalValue, 0);
  const totalDeals = data.reduce((sum, s) => sum + s.dealCount, 0);

  return (
    <Card data-testid="pipeline-summary-card">
      <CardHeader className="pb-2">
        <CardTitle className="text-base font-medium">Sales Pipeline</CardTitle>
        <CardDescription className="text-xs">
          {totalDeals} deal{totalDeals === 1 ? '' : 's'} ·{' '}
          {formatFullCurrency(totalValue, currency)}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {data.length === 0 ? (
          <p className="text-muted-foreground text-sm">No active deals</p>
        ) : (
          <div className="space-y-3">
            {data.map((stage) => (
              <div key={stage.stageId} className="space-y-1">
                <div className="flex items-center justify-between text-sm">
                  <span className="font-medium">{stage.stageName}</span>
                  <span className="text-muted-foreground">
                    {stage.dealCount} · {formatFullCurrency(stage.totalValue, currency)}
                  </span>
                </div>
                <div className="bg-muted h-2 w-full overflow-hidden rounded-full">
                  <div
                    className="bg-primary h-full rounded-full"
                    style={{
                      width: `${totalValue > 0 ? Math.min((stage.totalValue / totalValue) * 100, 100) : 0}%`,
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
