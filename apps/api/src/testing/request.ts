import { createServer, type RequestListener, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import supertest from 'supertest';

/**
 * supertest's `request(app)` for the API tests, with the app's server bound
 * to 127.0.0.1.
 *
 * supertest itself listens on '::' (every interface) and then connects to
 * 127.0.0.1. On macOS the kernel may give that socket a port that another
 * process already holds on 127.0.0.1 only, and that process answers the
 * request: random tests failed with a 405 or a body without `data`, about
 * one full run in ten on a laptop with two such listeners. A bind to
 * 127.0.0.1 itself is exclusive, but Node binds a named host
 * asynchronously while supertest reads the address synchronously, so here
 * each request is sent once the server is listening.
 */
export function request(app: Server | RequestListener) {
  const target = new LoopbackServer(typeof app === 'function' ? createServer(app) : app);
  const method = (name: string) => (path: string) => new LoopbackTest(target, name, path);
  return {
    get: method('GET'),
    post: method('POST'),
    put: method('PUT'),
    patch: method('PATCH'),
    delete: method('DELETE'),
    options: method('OPTIONS'),
    head: method('HEAD'),
  };
}

/** One request, as `request(app).get(path)` returns it. */
export type TestRequest = LoopbackTest;

/** Starts the server on first use and closes it after the last request. */
class LoopbackServer {
  private pending = 0;
  private started: Promise<string> | null = null;
  private startedHere = false;

  constructor(private readonly server: Server) {}

  /** The origin to send to; counts the request as pending. */
  open(): Promise<string> {
    this.pending += 1;
    if (this.server.listening && !this.started) return Promise.resolve(this.origin());
    this.started ??= new Promise<string>((resolve, reject) => {
      this.startedHere = true;
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => {
        this.server.off('error', reject);
        resolve(this.origin());
      });
    });
    return this.started;
  }

  done(): void {
    this.pending -= 1;
    if (this.pending > 0 || !this.startedHere) return;
    this.started = null;
    this.startedHere = false;
    this.server.close();
  }

  private origin(): string {
    const { address, port } = this.server.address() as AddressInfo;
    return `http://${address.includes(':') ? `[${address}]` : address}:${port}`;
  }
}

class LoopbackTest extends supertest.Test {
  constructor(
    private readonly target: LoopbackServer,
    method: string,
    private readonly route: string
  ) {
    // A URL string: supertest starts no server of its own. The real origin
    // is filled in by end(), once the server listens.
    super('http://127.0.0.1', method, route);
  }

  override end(callback?: supertest.CallbackHandler): this {
    this.target.open().then(
      (origin) => {
        this.url = origin + this.route;
        super.end((error, res) => {
          this.target.done();
          callback?.(error, res);
        });
      },
      (error: unknown) => {
        this.target.done();
        callback?.(error, undefined as never);
      }
    );
    return this;
  }
}
