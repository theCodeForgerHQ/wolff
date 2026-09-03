import { Suspense } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { StatsCards } from '@/components/dashboard/stats-cards';
import { RecentActivity } from '@/components/dashboard/recent-activity';
import { RecentQuotes, RecentInvoices } from '@/components/dashboard/recent-items';
import { AnalyticsSection } from '@/components/dashboard/analytics-section';
import { PaymentAgingChart } from '@/components/dashboard/charts';
import { GstSummaryCard } from '@/components/dashboard/gst-summary-card';
import { PipelineSummaryCard } from '@/components/dashboard/pipeline-summary-card';
import { getDashboardData } from '@/lib/dashboard/actions';
import { getWorkspaceCurrency } from '@/lib/settings/actions';
import { currencyCaption } from '@/lib/dashboard/currency-summary';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Dashboard',
  description: 'Your Wolff dashboard',
};

function getGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

function formatToday() {
  return new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
}

async function DashboardContent() {
  const [data, currency] = await Promise.all([getDashboardData(), getWorkspaceCurrency()]);

  return (
    <>
      {/* Stats Cards, and what currency their totals are in */}
      <div className="space-y-2">
        <StatsCards stats={data.stats} revenueData={data.revenueData} currency={currency} />
        <p className="text-muted-foreground text-xs" data-testid="dashboard-currency-note">
          {currencyCaption(currency, data.currencyNote.currencies, data.currencyNote)}
        </p>
      </div>

      {/* Revenue Chart (full width) */}
      <AnalyticsSection revenueData={data.revenueData} currency={currency} />

      {/* CRM / GST / Aging summary row */}
      <div className="grid gap-6 lg:grid-cols-3">
        <PaymentAgingChart data={data.paymentAging} className="lg:col-span-1" />
        <GstSummaryCard data={data.gstSummary} currency={currency} />
        <PipelineSummaryCard data={data.pipelineSummary} currency={currency} />
      </div>

      {/* Activity + Recent Items (2-column layout) */}
      <div className="grid gap-6 lg:grid-cols-5">
        <div className="lg:col-span-2">
          <RecentActivity activities={data.recentActivity} currency={currency} />
        </div>
        <div className="flex flex-col gap-6 lg:col-span-3">
          <div className="min-h-0 flex-1">
            <RecentQuotes quotes={data.recentQuotes} currency={currency} />
          </div>
          <div className="min-h-0 flex-1">
            <RecentInvoices invoices={data.recentInvoices} currency={currency} />
          </div>
        </div>
      </div>
    </>
  );
}

function DashboardSkeleton() {
  return (
    <>
      {/* Stats Cards Skeleton — single bordered row */}
      <Skeleton className="h-24 rounded-lg" />

      {/* Analytics Section Skeleton */}
      <Skeleton className="h-[350px]" />

      {/* CRM / GST / Aging summary row skeleton */}
      <div className="grid gap-6 lg:grid-cols-3">
        <Skeleton className="h-80" />
        <Skeleton className="h-80" />
        <Skeleton className="h-80" />
      </div>

      {/* Activity + Recent Items Skeleton */}
      <div className="grid gap-6 lg:grid-cols-5">
        <div className="lg:col-span-2">
          <Skeleton className="h-96" />
        </div>
        <div className="flex flex-col gap-6 lg:col-span-3">
          <Skeleton className="h-80" />
          <Skeleton className="h-80" />
        </div>
      </div>
    </>
  );
}

export default function DashboardPage() {
  return (
    <div className="space-y-8">
      {/* Page Header */}
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{getGreeting()}</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          {formatToday()} &mdash; Here&apos;s how your business is doing.
        </p>
      </div>

      <Suspense fallback={<DashboardSkeleton />}>
        <DashboardContent />
      </Suspense>
    </div>
  );
}
