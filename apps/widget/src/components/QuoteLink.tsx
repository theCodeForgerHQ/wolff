import type { WidgetConfig } from '../types';
import { tokenFromPage } from '../api';

interface QuoteLinkProps {
  config: WidgetConfig;
}

/**
 * A button that opens the hosted quote portal on the product's origin.
 * Accepting and signing happen there, never in the host page,
 * and the widget does not read the quote itself. The token comes from the
 * URL the client was emailed, so it is never part of the host page's HTML.
 */
export function QuoteLink({ config }: QuoteLinkProps) {
  const token = tokenFromPage('quote');

  if (!token) {
    return (
      <div className="ow-widget" aria-label="Quote link">
        <div className="ow-error" role="alert">
          Open this page from the link in your quote email.
        </div>
      </div>
    );
  }

  const portalUrl = `${config.appUrl.replace(/\/$/, '')}/q/${encodeURIComponent(token)}`;
  return (
    <div className="ow-widget" aria-label="Quote link">
      <h2 className="ow-title">Your quote is ready</h2>
      <a href={portalUrl} target="_blank" rel="noopener noreferrer" className="ow-link">
        Open quote
      </a>
    </div>
  );
}
