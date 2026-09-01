import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import type { BackupStore } from '../backup';
import type { ObjectStorage } from '../types';

interface S3Options {
  bucket: string;
  region: string;
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
}

function createS3Client(options: S3Options): S3Client {
  return new S3Client({
    region: options.region,
    ...(options.endpoint ? { endpoint: options.endpoint, forcePathStyle: true } : {}),
    // Without explicit keys the SDK uses its default chain (the task role on ECS).
    ...(options.accessKeyId && options.secretAccessKey
      ? {
          credentials: {
            accessKeyId: options.accessKeyId,
            secretAccessKey: options.secretAccessKey,
          },
        }
      : {}),
  });
}

/**
 * One storage driver for every S3-compatible store: AWS S3 in
 * production, Supabase Storage's S3 endpoint in the free demo, MinIO locally.
 * A custom endpoint needs path-style addressing.
 */
export function createS3Storage(options: S3Options): ObjectStorage {
  const client = createS3Client(options);

  return {
    async put(key, body, contentType) {
      await client.send(
        new PutObjectCommand({
          Bucket: options.bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
        })
      );
    },
  };
}

/**
 * Size of one multipart upload part: S3's minimum for every part but the
 * last. A backup stream is held in memory one part at a time.
 */
export const BACKUP_PART_BYTES = 5 * 1024 * 1024;

/**
 * Uploads a stream of unknown length: a single PUT when it ends within one
 * part, else a multipart upload completed only after the stream ends. If the
 * stream or a part fails, the multipart upload is aborted, so no object (and
 * no billable orphan parts) is left behind.
 */
async function putStream(
  client: S3Client,
  target: { Bucket: string; Key: string; ContentType: string },
  body: Readable
): Promise<void> {
  let uploadId: string | undefined;
  const parts: { ETag: string | undefined; PartNumber: number }[] = [];
  let pending: Buffer[] = [];
  let size = 0;
  const sendPart = async () => {
    uploadId ??= (await client.send(new CreateMultipartUploadCommand(target))).UploadId;
    const PartNumber = parts.length + 1;
    const { ETag } = await client.send(
      new UploadPartCommand({
        Bucket: target.Bucket,
        Key: target.Key,
        UploadId: uploadId,
        PartNumber,
        Body: Buffer.concat(pending),
      })
    );
    parts.push({ ETag, PartNumber });
    pending = [];
    size = 0;
  };

  try {
    for await (const chunk of body) {
      pending.push(chunk as Buffer);
      size += (chunk as Buffer).length;
      if (size >= BACKUP_PART_BYTES) await sendPart();
    }
    if (!uploadId) {
      await client.send(new PutObjectCommand({ ...target, Body: Buffer.concat(pending) }));
      return;
    }
    if (size > 0) await sendPart();
    await client.send(
      new CompleteMultipartUploadCommand({
        Bucket: target.Bucket,
        Key: target.Key,
        UploadId: uploadId,
        MultipartUpload: { Parts: parts },
      })
    );
  } catch (error) {
    if (uploadId) {
      // Best effort: the original error is the one to report. A part left
      // behind by a failed abort holds no complete object.
      await client
        .send(
          new AbortMultipartUploadCommand({
            Bucket: target.Bucket,
            Key: target.Key,
            UploadId: uploadId,
          })
        )
        .catch(() => undefined);
    }
    throw error;
  }
}

/**
 * The database backups' bucket (Supabase Storage bucket `backups` in the
 * demo): the same driver, plus list, get and delete for retention and restore.
 */
export function createS3BackupStore(options: S3Options): BackupStore {
  const client = createS3Client(options);
  const Bucket = options.bucket;

  return {
    put: (key, body, contentType) =>
      putStream(client, { Bucket, Key: key, ContentType: contentType }, body),
    async list(prefix) {
      const files: { key: string; lastModified: Date }[] = [];
      let ContinuationToken: string | undefined;
      do {
        const page = await client.send(
          new ListObjectsV2Command({ Bucket, Prefix: prefix, ContinuationToken })
        );
        for (const object of page.Contents ?? []) {
          if (object.Key && object.LastModified) {
            files.push({ key: object.Key, lastModified: object.LastModified });
          }
        }
        ContinuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (ContinuationToken);
      return files;
    },
    async get(key) {
      const object = await client.send(new GetObjectCommand({ Bucket, Key: key }));
      if (!object.Body) throw new Error(`Backup ${key} has no body`);
      // In Node the SDK's body is a Readable.
      return object.Body as Readable;
    },
    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket, Key: key }));
    },
  };
}

/** Files under a directory, for development without an object store. */
export function createLocalStorage(root: string): ObjectStorage {
  const base = resolve(root);

  return {
    async put(key, body) {
      const target = resolve(base, key);
      // The key must name a file inside the root, whatever it contains.
      if (!key || key.includes('\0') || !target.startsWith(base + sep)) {
        throw new Error('Invalid storage key');
      }
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, body);
    },
  };
}
