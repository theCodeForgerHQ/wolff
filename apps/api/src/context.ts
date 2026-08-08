/** Who a request acts as. Set by an auth middleware, never read from the body. */
export interface RequestContext {
  workspaceId: string;
  /** The API key id, or the service that issued the JWT. */
  keyId: string;
  scopes: string[];
  actor: 'api_key' | 'service' | 'publishable_key';
  rateLimitPerMin: number;
  /** The user a service acts on behalf of (`sub` of a service JWT). */
  userId?: string;
}

declare global {
  namespace Express {
    interface Request {
      ctx?: RequestContext;
    }
  }
}
