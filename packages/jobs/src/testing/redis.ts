import { createServer, type AddressInfo } from 'node:net';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';

/**
 * A Redis 7 container for tests, on a host port that stays the same across
 * `kill()` and `start()`. That lets a test take Redis away and bring back an
 * empty one at the same address, which is what a node replacement looks like.
 */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

export class TestRedis {
  private container: StartedTestContainer | null = null;
  private constructor(readonly port: number) {}

  static async start(): Promise<TestRedis> {
    const redis = new TestRedis(await freePort());
    await redis.start();
    return redis;
  }

  get running(): boolean {
    return this.container !== null;
  }

  get url(): string {
    return `redis://127.0.0.1:${this.port}`;
  }

  async start(): Promise<void> {
    this.container = await new GenericContainer('redis:7-alpine')
      // BullMQ requires noeviction; persistence off, as on ElastiCache.
      .withCommand([
        'redis-server',
        '--maxmemory-policy',
        'noeviction',
        '--save',
        '',
        '--appendonly',
        'no',
      ])
      .withExposedPorts({ container: 6379, host: this.port })
      .withWaitStrategy(Wait.forLogMessage('Ready to accept connections'))
      .start();
  }

  /** Stops and removes the container; its data is gone. */
  async kill(): Promise<void> {
    await this.container?.stop({ timeout: 0 });
    this.container = null;
  }
}
