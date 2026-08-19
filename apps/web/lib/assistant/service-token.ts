import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import type { WorkspaceRole } from '@/lib/workspace/get-current-workspace';

/**
 * The web app's service JWT for the AI service: HS256 with
 * SVC_JWT_SECRET_WEB, kid/iss `web`, aud `ai`, 60 s, the signed-in user as
 * `sub` and the active workspace. Scopes follow the workspace role; the AI
 * service can forward them to apps/api but never widen them.
 */
const TTL_SECONDS = 60;
const READ = ['quotes:read', 'invoices:read', 'leads:read', 'deals:read'];

export function scopesForRole(role: WorkspaceRole): string[] {
  return role === 'viewer' ? ['ai:use', ...READ] : ['ai:use', ...READ, 'quotes:write'];
}

export async function mintAssistantToken(input: {
  secret: string;
  userId: string;
  workspaceId: string;
  role: WorkspaceRole;
}): Promise<string> {
  if (!input.secret) throw new Error('SVC_JWT_SECRET_WEB is not set');
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ workspaceId: input.workspaceId, scopes: scopesForRole(input.role) })
    .setProtectedHeader({ alg: 'HS256', kid: 'web' })
    .setIssuer('web')
    .setAudience('ai')
    .setSubject(input.userId)
    .setIssuedAt(now)
    .setExpirationTime(now + TTL_SECONDS)
    .setJti(randomUUID())
    .sign(new TextEncoder().encode(input.secret));
}
