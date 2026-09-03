// k6 load test of the API's read paths, against a local stack only
// (scripts/loadtest.sh). Never point it at the free demo: the vendors'
// free tiers are the bottleneck there, and hitting them is abuse.
import http from 'k6/http';
import { check } from 'k6';

const BASE = __ENV.API_URL || 'http://127.0.0.1:4200';
const KEY = __ENV.API_KEY;
const INVOICE_ID = __ENV.INVOICE_ID;
const auth = { headers: { Authorization: `Bearer ${KEY}` } };

export const options = {
  scenarios: {
    // Arrival rate, not VUs: the offered load is fixed, so a slow server
    // shows up as latency and dropped iterations, not as fewer requests.
    reads: {
      executor: 'ramping-arrival-rate',
      startRate: 10,
      timeUnit: '1s',
      preAllocatedVUs: 50,
      maxVUs: 600,
      stages: [
        { target: 50, duration: '30s' },
        { target: 50, duration: '60s' },
        { target: 100, duration: '30s' },
        { target: 100, duration: '60s' },
        { target: 200, duration: '30s' },
        { target: 200, duration: '60s' },
        { target: 400, duration: '30s' },
        { target: 400, duration: '60s' },
      ],
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    'http_req_duration{name:clients}': ['p(95)<500'],
  },
  summaryTrendStats: ['avg', 'p(50)', 'p(95)', 'p(99)', 'max'],
};

export default function () {
  const r = Math.random();
  let res;
  if (r < 0.4) {
    res = http.get(`${BASE}/v1/clients?limit=20`, { ...auth, tags: { name: 'clients' } });
  } else if (r < 0.8) {
    res = http.get(`${BASE}/v1/invoices?limit=20`, { ...auth, tags: { name: 'invoices' } });
  } else {
    res = http.get(`${BASE}/v1/invoices/${INVOICE_ID}`, { ...auth, tags: { name: 'invoice' } });
  }
  // Status and error of each failure, so the summary's failure count can be
  // explained. A 429 from the per-key limiter carries RateLimit-Policy (it
  // runs after the key check); one from the failed-auth limiter does not.
  if (!check(res, { 'status 200': (x) => x.status === 200 })) {
    const limiter =
      res.status !== 429 ? '' : res.headers['Ratelimit-Policy'] ? 'per-key' : 'failed-auth';
    console.warn(`failed: ${res.status} ${limiter} ${res.error || ''} ${res.request.url}`);
  }
}
