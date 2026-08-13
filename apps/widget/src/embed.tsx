import { render } from 'preact';
import { Widget } from './components/Widget';
import { LeadForm } from './components/LeadForm';
import { InvoicePay } from './components/InvoicePay';
import { QuoteLink } from './components/QuoteLink';
import type { WidgetConfig, WidgetMode } from './types';
import widgetCss from './index.css?inline';

const WIDGET_ATTR = 'data-wolff-widget';
export const INTERACTIVE_MARK = 'wolff-widget:interactive';

interface EmbedOptions {
  apiBaseUrl?: string;
  /** The product origin (hosted quote portal). */
  appUrl?: string;
  publishableKey?: string;
  mode?: WidgetMode;
  onSuccess?: (data: unknown) => void;
  onError?: (error: Error) => void;
}

function readScriptOptions(): EmbedOptions {
  const script = document.querySelector(`script[${WIDGET_ATTR}]`) as HTMLScriptElement | null;
  if (!script) return {};

  return {
    apiBaseUrl: script.dataset.apiBaseUrl,
    publishableKey: script.dataset.key,
    appUrl: script.dataset.appUrl,
    mode: (script.dataset.mode as WidgetMode) ?? 'lead-form',
  };
}

function findTargets(mode: WidgetMode): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(`[${WIDGET_ATTR}="${mode}"]`));
}

function mount(target: HTMLElement, options: EmbedOptions): { unmount: () => void } | null {
  const mode = options.mode ?? 'lead-form';
  const publishableKey = options.publishableKey?.trim();
  const apiBaseUrl = (options.apiBaseUrl ?? 'http://localhost:4000').trim();
  const appUrl = (options.appUrl ?? 'http://localhost:3000').trim();

  if (!publishableKey) {
    // eslint-disable-next-line no-console
    console.error('[WolffWidget] publishableKey is required');
    return null;
  }

  const config: WidgetConfig = {
    apiBaseUrl,
    appUrl,
    publishableKey,
    mode,
    target,
    onSuccess: options.onSuccess,
    onError: options.onError,
  };

  const shadow = target.attachShadow({ mode: 'open' });
  const styleSlot = document.createElement('style');
  styleSlot.textContent = `:host { display: block; }\n${widgetCss}`;
  shadow.appendChild(styleSlot);

  const container = document.createElement('div');
  container.style.display = 'contents';
  shadow.appendChild(container);

  render(<Widget config={config} />, container);
  // Preact renders synchronously: the form and its handlers exist now. The
  // performance budget (interactive ≤ 300 ms after
  // DOMContentLoaded) is measured against this mark.
  if (
    typeof performance !== 'undefined' &&
    performance.getEntriesByName(INTERACTIVE_MARK).length === 0
  ) {
    performance.mark(INTERACTIVE_MARK);
  }
  return {
    unmount: () => {
      render(null as unknown as preact.VNode, container);
    },
  };
}

const mountedRoots = new Map<HTMLElement, { unmount: () => void }>();

export function init(options: EmbedOptions = {}): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  const scriptOptions = readScriptOptions();
  const mode = options.mode ?? scriptOptions.mode ?? 'lead-form';
  const targets = findTargets(mode);

  if (targets.length === 0) {
    // eslint-disable-next-line no-console
    console.warn(`[WolffWidget] no target elements found for mode "${mode}"`);
    return;
  }

  for (const target of targets) {
    if (mountedRoots.has(target)) continue;
    const root = mount(target, {
      ...scriptOptions,
      ...options,
      mode,
    });
    if (root) {
      mountedRoots.set(target, root);
    }
  }
}

export function destroy(): void {
  for (const [target, root] of mountedRoots) {
    root.unmount();
    if (target.shadowRoot) {
      target.shadowRoot.innerHTML = '';
    }
    mountedRoots.delete(target);
  }
}

// Auto-init when the script is loaded via data- attributes.
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => init());
  } else {
    init();
  }
}

export { Widget, LeadForm, InvoicePay, QuoteLink };
export type { WidgetConfig, WidgetMode, EmbedOptions };
