import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from '../config.js';

export const s3 = new S3Client({
  endpoint: config.S3_ENDPOINT,
  region: config.S3_REGION,
  forcePathStyle: config.S3_FORCE_PATH_STYLE,
  credentials: { accessKeyId: config.S3_ACCESS_KEY, secretAccessKey: config.S3_SECRET_KEY }
});

export const buckets = {
  firmware: config.S3_BUCKET_FIRMWARE,
  templates: config.S3_BUCKET_TEMPLATES,
  exports: config.S3_BUCKET_EXPORTS,
  backups: config.S3_BUCKET_BACKUPS
};

export async function ensureBuckets() {
  for (const b of Object.values(buckets)) {
    try {
      await s3.send(new HeadBucketCommand({ Bucket: b }));
    } catch {
      await s3.send(new CreateBucketCommand({ Bucket: b }));
    }
  }
}

export async function putObject(bucket: string, key: string, body: Buffer, contentType = 'application/octet-stream') {
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }));
}

export async function getObject(bucket: string, key: string): Promise<Buffer> {
  const r = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const bytes = await r.Body!.transformToByteArray();
  return Buffer.from(bytes);
}

export async function deleteObject(bucket: string, key: string) {
  await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

export async function listObjects(bucket: string, prefix: string) {
  const out: { key: string; lastModified?: Date; size?: number }[] = [];
  let token: string | undefined;
  do {
    const r = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
    for (const o of r.Contents ?? []) out.push({ key: o.Key!, lastModified: o.LastModified, size: o.Size });
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  return out;
}

export function presignGet(bucket: string, key: string, expiresIn = 3600) {
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn });
}

export async function storageHealthy(): Promise<boolean> {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: buckets.firmware }));
    return true;
  } catch {
    return false;
  }
}
