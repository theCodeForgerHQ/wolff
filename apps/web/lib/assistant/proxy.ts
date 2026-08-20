import { getCurrentUserWorkspace } from '@/lib/workspace/get-current-workspace';
import { mintAssistantToken } from './service-token';

/**
 * Server side of the assistant: the AI service's origin and our secret
 * come from the environment; without them the assistant is off and the
 * rest of the app is unaffected (the "AI service down" case).
 */
const HEALTH_TIMEOUT_MS = 1_500;
const HEALTH_CACHE_MS = 30_000;

export function aiBaseUrl(): string | null {
  const url = process.env.AI_URL?.trim();
  return url && process.env.SVC_JWT_SECRET_WEB ? url.replace(/\/$/, '') : null;
}

let cached: { at: number; available: boolean } | null = null;

/** Whether the AI service answers its health check; cached for 30 s. */
export async function aiAvailable(now = Date.now()): Promise<boolean> {
  const base = aiBaseUrl();
  if (!base) return false;
  if (cached && now - cached.at < HEALTH_CACHE_MS) return cached.available;
  let available = false;
  try {
    const res = await fetch(`${base}/healthz`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      cache: 'no-store',
    });
    available = res.ok;
  } catch {
    available = false;
  }
  cached = { at: now, available };
  return available;
}

export function resetAiHealthCache(): void {
  cached = null;
}

/** POSTs to the AI service as the signed-in user of the active workspace. */
export async function callAi(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
  const base = aiBaseUrl();
  if (!base) throw new AssistantUnavailable();
  const { userId, workspaceId, role } = await getCurrentUserWorkspace();
  const token = await mintAssistantToken({
    secret: process.env.SVC_JWT_SECRET_WEB ?? '',
    userId,
    workspaceId,
    role,
  });
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
    cache: 'no-store',
  });
}

export class AssistantUnavailable extends Error {
  constructor() {
    super('The assistant is not available');
    this.name = 'AssistantUnavailable';
  }
}
