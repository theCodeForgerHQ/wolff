import type { WidgetConfig } from '../types';
import { LeadForm } from './LeadForm';
import { InvoicePay } from './InvoicePay';
import { QuoteLink } from './QuoteLink';

interface WidgetProps {
  config: WidgetConfig;
}

export function Widget({ config }: WidgetProps) {
  switch (config.mode) {
    case 'lead-form':
      return <LeadForm config={config} />;
    case 'invoice-pay':
      return <InvoicePay config={config} />;
    case 'quote-link':
      return <QuoteLink config={config} />;
    default:
      return (
        <div className="ow-widget" role="alert">
          <div className="ow-error">Unknown widget mode.</div>
        </div>
      );
  }
}
