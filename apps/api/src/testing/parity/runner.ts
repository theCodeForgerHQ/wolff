import { PARITY, PARITY_ID_PATTERN } from './seed';
import { PARITY_SCENARIO, type ParityContext, type ParityStep } from './scenario';

/** One response, as stored in the recording and compared byte for byte. */
export interface ParityResponse {
  name: string;
  group: ParityStep['group'];
  method: string;
  path: string;
  status: number;
  /** The response body after `normalizeBody`. */
  body: string;
  authFailure?: boolean;
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const HEX64 = /\b[0-9a-f]{64}\b/g;
const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g;
/** GST numbers carry the financial year of the day they were issued ("INV/26-27/0001"). */
const FINANCIAL_YEAR = /\b(INV|CN)\/\d{2}-\d{2}\//g;

/**
 * Replaces what legitimately differs between two runs: ids and access tokens
 * the run generated (numbered by first appearance, so the same id keeps the
 * same name across the whole run), timestamps taken from the clock, calendar
 * dates computed from today (as days from today, `<today+15>`) and the
 * financial year in GST document numbers. Seed ids and every 2025 date (the
 * seed's and the scenario's) are kept, so they are compared exactly.
 */
const DAY_MS = 86_400_000;

function relativeDate(ts: string): string {
  if (ts.startsWith('2025-')) return ts;
  if (!ts.endsWith('T00:00:00.000Z')) return '<now>';
  const today = Date.UTC(
    new Date().getUTCFullYear(),
    new Date().getUTCMonth(),
    new Date().getUTCDate()
  );
  const days = Math.round((Date.parse(ts) - today) / DAY_MS);
  return `<today${days >= 0 ? '+' : ''}${days}>`;
}

export class Normalizer {
  private readonly names = new Map<string, string>();

  normalize(text: string): string {
    return text
      .replace(UUID, (id) => (PARITY_ID_PATTERN.test(id) ? id : this.name('id', id)))
      .replace(HEX64, (token) => this.name('token', token))
      .replace(ISO, relativeDate)
      .replace(FINANCIAL_YEAR, '$1/<fy>/');
  }

  private name(kind: string, value: string): string {
    let name = this.names.get(value);
    if (!name) {
      name = `<${kind}:${this.names.size + 1}>`;
      this.names.set(value, name);
    }
    return name;
  }
}

const BEARER: Record<NonNullable<ParityStep['auth']>, string | null> = {
  main: PARITY.key,
  gst: PARITY.gstKey,
  none: null,
  invalid: 'qc_sk_parity0000000000000000000000000999',
};

/**
 * Runs the scenario against `baseUrl + prefix` (`/api/v1` on Next, `/v1` on
 * the API) and returns every response, normalized. Each request comes from
 * its own `X-Forwarded-For` address so the Next routes' per-IP limit (100 a
 * minute) never answers 429 during a run.
 */
export async function runParityScenario(
  baseUrl: string,
  prefix: string,
  steps: ParityStep[] = PARITY_SCENARIO
): Promise<ParityResponse[]> {
  const ctx: ParityContext = { created: {} };
  const normalizer = new Normalizer();
  const out: ParityResponse[] = [];

  for (const [index, step] of steps.entries()) {
    const path = typeof step.path === 'function' ? step.path(ctx) : step.path;
    const headers: Record<string, string> = {
      'X-Forwarded-For': `10.66.${Math.floor(index / 250)}.${(index % 250) + 1}`,
    };
    const bearer = BEARER[step.auth ?? 'main'];
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
    let body: string | undefined;
    if (step.rawBody !== undefined) body = step.rawBody;
    else if (step.body !== undefined) body = JSON.stringify(step.body);
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    const res = await fetch(`${baseUrl}${prefix}${path}`, { method: step.method, headers, body });
    const text = await res.text();
    if (step.capture && res.ok) {
      ctx.created[step.capture] = (JSON.parse(text) as { id: string }).id;
    }
    out.push({
      name: step.name,
      group: step.group,
      method: step.method,
      path: normalizer.normalize(path),
      status: res.status,
      body: normalizer.normalize(text),
      ...(step.authFailure ? { authFailure: true } : {}),
    });
  }
  return out;
}
