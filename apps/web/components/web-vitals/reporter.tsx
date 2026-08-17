'use client';

import { useReportWebVitals } from 'next/web-vitals';

const ENDPOINT = '/api/vitals';

/** Sends one vital to /api/vitals; prefers a beacon so it survives page unload. */
export function sendVital(metric: {
  name: string;
  value: number;
  id: string;
  navigationType?: string;
}): void {
  if (typeof navigator === 'undefined') return;
  const body = JSON.stringify({
    name: metric.name,
    value: metric.value,
    id: metric.id,
    navigationType: metric.navigationType,
  });
  if (typeof navigator.sendBeacon === 'function' && navigator.sendBeacon(ENDPOINT, body)) return;
  fetch(ENDPOINT, { body, method: 'POST', keepalive: true }).catch(() => {
    // Vitals are best effort; a lost sample must never surface to the user.
  });
}

export function WebVitalsReporter() {
  useReportWebVitals((metric) =>
    sendVital({
      name: metric.name,
      value: metric.value,
      id: metric.id,
      navigationType: 'navigationType' in metric ? metric.navigationType : undefined,
    })
  );
  return null;
}
