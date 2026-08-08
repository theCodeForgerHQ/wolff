import { useState, useEffect } from 'preact/compat';
import type { WidgetConfig } from '../types';
import { getQuotePublic } from '../api';

interface QuoteLinkProps {
  config: WidgetConfig;
}

export function QuoteLink({ config }: QuoteLinkProps) {
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [quote, setQuote] = useState<{ title: string; status: string } | null>(null);

  const token = config.quoteToken;
  const portalUrl = token ? `${config.apiBaseUrl.replace(/\/api$/, '')}/q/${token}` : '';

  useEffect(() => {
    if (!token) {
      setError('Quote token is missing.');
      setIsLoading(false);
      return;
    }

    let cancelled = false;
    getQuotePublic(config, token)
      .then((data) => {
        if (!cancelled) {
          setQuote(data);
          setIsLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          const message = err instanceof Error ? err.message : 'Unable to load quote.';
          setError(message);
          setIsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [config, token]);

  if (isLoading) {
    return (
      <div className="ow-widget" aria-label="Quote link">
        <p style={{ margin: 0, fontSize: '14px', color: '#4b5563' }}>Loading quote...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="ow-widget" aria-label="Quote link">
        <div className="ow-error" role="alert">
          {error}
        </div>
      </div>
    );
  }

  return (
    <div className="ow-widget" aria-label="Quote link">
      <h2 className="ow-title">{quote?.title ?? 'Review quote'}</h2>
      <a
        href={portalUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="ow-link"
        role="button"
      >
        Open quote
      </a>
    </div>
  );
}
