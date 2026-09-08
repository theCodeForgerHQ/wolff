/**
 * The condition that a quote's or invoice's access token has not expired.
 * The token is the client's whole credential for the portal, PDFs and
 * downloads; the API honoured accessTokenExpiresAt, the web app did not, so
 * a leaked link stayed valid for ever. No expiry set means the link does not
 * expire.
 */
export function unexpiredAccessToken(now: Date = new Date()) {
  return {
    AND: [{ OR: [{ accessTokenExpiresAt: null }, { accessTokenExpiresAt: { gt: now } }] }],
  };
}
