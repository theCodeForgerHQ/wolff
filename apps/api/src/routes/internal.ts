import { Router } from 'express';
import type { ApiConfig } from '../config';
import { sendData } from '../http';
import { requireServiceJwt, type ReplayCache } from '../middleware/service-jwt';

/**
 * `/internal/*`: calls from our own services. Only a service JWT
 * opens them. On AWS the load balancer also keeps them off the public
 * listener; on the free demo there is no private network and the signature
 * is the only protection.
 *
 * Phase 2 has one route, the health check the other services use to verify
 * that their secret is accepted. The GST, quote-draft and report routes
 * arrive with the phases that build those features.
 */
export function internalRoutes(config: ApiConfig, replayCache: ReplayCache): Router {
  const router = Router();
  router.use(
    requireServiceJwt({
      secrets: { web: config.SVC_JWT_SECRET_WEB, ai: config.SVC_JWT_SECRET_AI },
      issuers: ['web', 'ai'],
      audience: 'api',
      replayCache,
    })
  );

  router.get('/healthz', (req, res) => {
    sendData(res, {
      status: 'ok',
      issuer: req.ctx!.keyId,
      workspaceId: req.ctx!.workspaceId,
      subject: req.ctx!.userId,
    });
  });
  return router;
}
