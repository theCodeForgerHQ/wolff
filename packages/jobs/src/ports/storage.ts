import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { ObjectStorage } from '../types';

/**
 * One storage driver for every S3-compatible store: AWS S3 in
 * production, Supabase Storage's S3 endpoint in the free demo, MinIO locally.
 * A custom endpoint needs path-style addressing.
 */
export function createS3Storage(options: {
  bucket: string;
  region: string;
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
}): ObjectStorage {
  const client = new S3Client({
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
