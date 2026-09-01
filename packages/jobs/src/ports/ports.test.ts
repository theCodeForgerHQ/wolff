import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { randomBytes } from 'node:crypto';
import {
  CreateBucketCommand,
  GetObjectCommand,
  ListMultipartUploadsCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createLogEmailTransport, createResendTransport } from './email';
import {
  BACKUP_PART_BYTES,
  createLocalStorage,
  createS3BackupStore,
  createS3Storage,
} from './storage';

async function bytes(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** `total` bytes in 64 KiB chunks, like a gzip stream delivers them. */
function chunked(data: Buffer, failAfter?: number): Readable {
  return Readable.from(
    (function* () {
      for (let at = 0; at < data.length; at += 65_536) {
        if (failAfter !== undefined && at >= failAfter) throw new Error('source failed');
        yield data.subarray(at, at + 65_536);
      }
    })()
  );
}

describe('Resend email transport', () => {
  let server: Server;
  let baseUrl = '';
  const received: { headers: Record<string, unknown>; body: Record<string, unknown> }[] = [];
  let status = 200;

  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', () => {
        received.push({ headers: req.headers, body: JSON.parse(raw) });
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify(
            status === 200 ? { id: 'email_1' } : { message: 'rate limited for asha@example.test' }
          )
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  beforeEach(() => {
    received.length = 0;
    status = 200;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const message = {
    to: 'asha@example.test',
    subject: 'Reminder',
    html: '<p>Hello</p>',
    idempotencyKey: 'email:abc',
  };

  it('posts the message with the API key and the idempotency key', async () => {
    const transport = createResendTransport({
      apiKey: 're_test',
      from: 'Billing <billing@example.test>',
      baseUrl,
    });

    await transport.send(message);

    expect(received).toHaveLength(1);
    expect(received[0]!.headers.authorization).toBe('Bearer re_test');
    expect(received[0]!.headers['idempotency-key']).toBe('email:abc');
    expect(received[0]!.body).toEqual({
      from: 'Billing <billing@example.test>',
      to: ['asha@example.test'],
      subject: 'Reminder',
      html: '<p>Hello</p>',
    });
  });

  it('strips line breaks from the subject, so it cannot add headers', async () => {
    const transport = createResendTransport({ apiKey: 're_test', from: 'a@example.test', baseUrl });

    await transport.send({ ...message, subject: 'Hi\r\nBcc: evil@example.test' });

    expect(received[0]!.body.subject).toBe('Hi Bcc: evil@example.test');
  });

  it('throws on a non-2xx answer, with the status and without the response body', async () => {
    status = 429;
    const transport = createResendTransport({ apiKey: 're_test', from: 'a@example.test', baseUrl });

    await expect(transport.send(message)).rejects.toThrow('Resend answered 429');
    await expect(transport.send(message)).rejects.not.toThrow(/asha@example.test/);
  });

  it('the development transport sends nothing and records what it would have sent', async () => {
    const logged: unknown[] = [];
    const transport = createLogEmailTransport((entry) => logged.push(entry));

    await transport.send(message);

    expect(received).toHaveLength(0);
    expect(logged).toEqual([{ idempotencyKey: 'email:abc', recipientCount: 1, redirected: false }]);
  });
});

describe('local file storage', () => {
  let dir = '';

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'storage-'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes the object under its key', async () => {
    const storage = createLocalStorage(dir);

    await storage.put('pdfs/ws-1/invoice/a.pdf', new Uint8Array([1, 2, 3]), 'application/pdf');

    expect([...(await readFile(join(dir, 'pdfs/ws-1/invoice/a.pdf')))]).toEqual([1, 2, 3]);
  });

  it.each(['../escape.pdf', 'pdfs/../../escape.pdf', '/etc/passwd', 'pdfs/\0x.pdf', ''])(
    'refuses the key %j',
    async (key) => {
      const storage = createLocalStorage(dir);

      await expect(storage.put(key, new Uint8Array([1]), 'application/pdf')).rejects.toThrow(
        /Invalid storage key/
      );
    }
  );
});

// MinIO no longer publishes images on Docker Hub; S3Mock is a small
// S3-compatible server that is enough to prove the driver talks the protocol
// to a custom endpoint with path-style addressing.
describe.skipIf(!process.env.TEST_DATABASE_URL)('S3 storage (S3Mock container)', () => {
  let s3: StartedTestContainer;
  let endpoint = '';
  const credentials = { accessKeyId: 'test', secretAccessKey: 'test' };

  beforeAll(async () => {
    s3 = await new GenericContainer('adobe/s3mock:4.11.0')
      .withExposedPorts(9090)
      .withWaitStrategy(Wait.forHttp('/', 9090))
      .start();
    endpoint = `http://${s3.getHost()}:${s3.getMappedPort(9090)}`;
    const admin = new S3Client({
      endpoint,
      region: 'us-east-1',
      credentials,
      forcePathStyle: true,
    });
    await admin.send(new CreateBucketCommand({ Bucket: 'pdfs' }));
    await admin.send(new CreateBucketCommand({ Bucket: 'backups' }));
  }, 180_000);

  afterAll(async () => {
    await s3?.stop();
  });

  it('stores an object on an S3-compatible endpoint with path-style addressing', async () => {
    const storage = createS3Storage({
      endpoint,
      region: 'us-east-1',
      bucket: 'pdfs',
      ...credentials,
    });

    await storage.put(
      'pdfs/ws-1/invoice/a.pdf',
      new Uint8Array([37, 80, 68, 70]),
      'application/pdf'
    );

    const client = new S3Client({
      endpoint,
      region: 'us-east-1',
      credentials,
      forcePathStyle: true,
    });
    const object = await client.send(
      new GetObjectCommand({ Bucket: 'pdfs', Key: 'pdfs/ws-1/invoice/a.pdf' })
    );
    expect(object.ContentType).toBe('application/pdf');
    expect([...(await object.Body!.transformToByteArray())]).toEqual([37, 80, 68, 70]);
  });

  it('puts, lists by prefix, reads back and deletes backup files', async () => {
    const store = createS3BackupStore({
      endpoint,
      region: 'us-east-1',
      bucket: 'backups',
      ...credentials,
    });

    await store.put('db/a.ndjson.gz', Readable.from([Buffer.from([1, 2, 3])]), 'application/gzip');
    await store.put('db/b.ndjson.gz', Readable.from([Buffer.from([4])]), 'application/gzip');
    await store.put('other/c', Readable.from([Buffer.from([5])]), 'application/octet-stream');

    const listed = await store.list('db/');
    expect(listed.map((file) => file.key).sort()).toEqual(['db/a.ndjson.gz', 'db/b.ndjson.gz']);
    expect(listed.every((file) => file.lastModified instanceof Date)).toBe(true);
    expect([...(await bytes(await store.get('db/a.ndjson.gz')))]).toEqual([1, 2, 3]);

    await store.delete('db/a.ndjson.gz');
    expect((await store.list('db/')).map((file) => file.key)).toEqual(['db/b.ndjson.gz']);
  });

  // Ten-plus MiB through a container: 0.5 s alone, but well past vitest's 5 s
  // default while the other packages' suites load the machine.
  const MULTIPART_TIMEOUT_MS = 30_000;

  it(
    'streams a backup larger than one part as a multipart upload',
    async () => {
      const store = createS3BackupStore({
        endpoint,
        region: 'us-east-1',
        bucket: 'backups',
        ...credentials,
      });
      const data = randomBytes(2 * BACKUP_PART_BYTES + 12_345);

      await store.put('db/big.enc', chunked(data), 'application/octet-stream');

      expect((await bytes(await store.get('db/big.enc'))).equals(data)).toBe(true);
    },
    MULTIPART_TIMEOUT_MS
  );

  it(
    'aborts the multipart upload and stores nothing when the source fails',
    async () => {
      const store = createS3BackupStore({
        endpoint,
        region: 'us-east-1',
        bucket: 'backups',
        ...credentials,
      });
      const data = randomBytes(2 * BACKUP_PART_BYTES);

      await expect(
        store.put('db/broken.enc', chunked(data, BACKUP_PART_BYTES + 65_536), 'application/gzip')
      ).rejects.toThrow(/source failed/);

      expect((await store.list('db/')).map((file) => file.key)).not.toContain('db/broken.enc');
      const client = new S3Client({
        endpoint,
        region: 'us-east-1',
        credentials,
        forcePathStyle: true,
      });
      const uploads = await client.send(new ListMultipartUploadsCommand({ Bucket: 'backups' }));
      expect(uploads.Uploads ?? []).toEqual([]);
    },
    MULTIPART_TIMEOUT_MS
  );
});
