import { lookup as dnsLookup } from 'node:dns';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import type { WebhookTransport } from './deliver';
import { isPublicAddress } from './ssrf';

const MAX_RESPONSE_BYTES = 64 * 1024;
const PRIVATE_ADDRESS = 'Webhook URL resolves to a private address';

/**
 * DNS lookup that refuses private addresses. It is the lookup the socket
 * itself uses, so the address that was checked is the address that is
 * connected to; checking first and resolving again later would leave a gap
 * for DNS rebinding.
 */
const guardedLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error, '', 0);
    const list = Array.isArray(addresses) ? addresses : [addresses];
    if (list.length === 0 || list.some((entry) => !isPublicAddress(entry.address))) {
      return callback(new Error(PRIVATE_ADDRESS), '', 0);
    }
    if ((options as { all?: boolean }).all) {
      return (callback as unknown as (e: null, a: typeof list) => void)(null, list);
    }
    callback(null, list[0]!.address, list[0]!.family);
  });
};

export interface HttpTransportOptions {
  /** Skip the private-address check. For tests and local development only. */
  allowPrivateAddresses?: boolean;
}

/**
 * The transport that really sends webhooks: one POST, no redirects followed,
 * a hard timeout, and a bounded response read.
 */
export function createHttpTransport(options: HttpTransportOptions = {}): WebhookTransport {
  return {
    post(target, { headers, body, timeoutMs }) {
      return new Promise((resolve, reject) => {
        const url = new URL(target);
        const host = url.hostname.replace(/^\[|\]$/g, '');
        if (!options.allowPrivateAddresses && isIP(host) !== 0 && !isPublicAddress(host)) {
          reject(new Error(PRIVATE_ADDRESS));
          return;
        }

        const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
        const req = send(
          url,
          {
            method: 'POST',
            headers: { ...headers, 'Content-Length': Buffer.byteLength(body).toString() },
            lookup: options.allowPrivateAddresses ? undefined : guardedLookup,
            // A fresh connection per delivery: a pooled socket would skip the lookup.
            agent: false,
          },
          (res) => {
            const chunks: Buffer[] = [];
            let size = 0;
            const finish = () => {
              clearTimeout(timer);
              resolve({
                status: res.statusCode ?? 0,
                body: Buffer.concat(chunks).toString('utf8').slice(0, MAX_RESPONSE_BYTES),
              });
            };
            res.on('data', (chunk: Buffer) => {
              size += chunk.length;
              if (size <= MAX_RESPONSE_BYTES) chunks.push(chunk);
              else {
                res.destroy();
                finish();
              }
            });
            res.on('end', finish);
            res.on('error', finish);
          }
        );
        const timer = setTimeout(() => {
          req.destroy(new Error(`Webhook request timed out after ${timeoutMs} ms`));
        }, timeoutMs);
        req.on('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        req.end(body);
      });
    },
  };
}
