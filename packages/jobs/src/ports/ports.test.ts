import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CreateBucketCommand, GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createLogEmailTransport, createResendTransport } from './email';
import { createLocalStorage, createS3Storage } from './storage';

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
    expect(logged).toEqual([{ subject: 'Reminder', idempotencyKey: 'email:abc' }]);
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
});
