import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
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
 * The database backups' bucket (Supabase Storage bucket `backups` in the
 * demo): the same driver, plus list, get and delete for retention and restore.
 */
export function createS3BackupStore(options: S3Options): BackupStore {
  const client = createS3Client(options);
  const Bucket = options.bucket;

  return {
    async put(key, body, contentType) {
      await client.send(
        new PutObjectCommand({ Bucket, Key: key, Body: body, ContentType: contentType })
      );
    },
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
      return object.Body.transformToByteArray();
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
