import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { FinancialHealthSection } from '@/components/analytics/financial-health-section';
import { SalesPipelineSection } from '@/components/analytics/sales-pipeline-section';

const zeroCounts = {
  draft: 1,
  sent: 0,
  viewed: 0,
  accepted: 0,
  declined: 0,
  expired: 0,
  converted: 0,
};

/**
 * The dashboard's totals are converted to the workspace's base currency
 * (lib/dashboard/actions.ts), so these sections show that currency and say
 * so. They used to format every amount as USD.
 */
describe('analytics sections', () => {
  it('shows the financial figures in the base currency, labelled', () => {
    const { container } = render(
      <FinancialHealthSection
        currency="INR"
        outstandingAmount={120000}
        overdueAmount={20000}
        revenueThisMonth={50000}
        paymentAging={{
          current: 100000,
          days1to30: 20000,
          days31to60: 0,
          days61to90: 0,
          days90plus: 0,
          totalOutstanding: 120000,
        }}
      />
    );
    expect(container.textContent).toContain('₹');
    expect(container.textContent).not.toContain('$');
    expect(container.textContent).toContain('Amounts in INR');
  });

  it('shows the average deal value in the base currency, labelled', () => {
    const { container } = render(
      <SalesPipelineSection
        currency="EUR"
        conversionRate={10}
        avgDealValue={4200}
        quoteStatusCounts={zeroCounts}
        conversionFunnel={{
          quotesCreated: 1,
          quotesSent: 0,
          quotesViewed: 0,
          quotesAccepted: 0,
          invoicesCreated: 0,
          invoicesPaid: 0,
        }}
      />
    );
    expect(container.textContent).toContain('€');
    expect(container.textContent).not.toContain('$');
    expect(container.textContent).toContain('in EUR');
  });
});
