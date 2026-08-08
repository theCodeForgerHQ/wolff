'use client';

import { useReportWebVitals } from 'next/web-vitals';

export function WebVitalsReporter() {
  useReportWebVitals((metric) => {
    if (typeof navigator === 'undefined' || navigator.sendBeacon) {
      const body = JSON.stringify({
        name: metric.name,
        value: metric.value,
        id: metric.id,
        navigationType: 'navigationType' in metric ? metric.navigationType : undefined,
      });
      if (navigator.sendBeacon) {
        navigator.sendBeacon('/api/vitals', body);
      } else {
        fetch('/api/vitals', { body, method: 'POST', keepalive: true }).catch(() => {});
      }
    }
  });
  return null;
}
