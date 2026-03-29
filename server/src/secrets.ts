import { KMSClient, EncryptCommand, DecryptCommand } from '@aws-sdk/client-kms';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { AWS_REGION, KMS_KEY_ID } from './config.js';

const kms = KMS_KEY_ID ? new KMSClient({ region: AWS_REGION }) : null;

function getLocalKey(): Buffer {
  const raw = process.env.ENCRYPTION_KEY ?? '';
  if (!raw) {
    throw new Error('ENCRYPTION_KEY must be set when KMS_KEY_ID is empty');
  }
  return scryptSync(raw, 'ai-ebot-salt', 32);
}

export async function encryptSecret(plaintext: string): Promise<{ blob: Buffer; kmsKeyId?: string }> {
  if (kms && KMS_KEY_ID) {
    const out = await kms.send(
      new EncryptCommand({
        KeyId: KMS_KEY_ID,
        Plaintext: Buffer.from(plaintext, 'utf8'),
      })
    );
    if (!out.CiphertextBlob) {
      throw new Error('KMS encrypt failed');
    }
    return { blob: Buffer.from(out.CiphertextBlob), kmsKeyId: KMS_KEY_ID };
  }
  const key = getLocalKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { blob: Buffer.concat([iv, tag, enc]) };
}

export async function decryptSecret(blob: Buffer): Promise<string> {
  if (kms && KMS_KEY_ID) {
    const out = await kms.send(new DecryptCommand({ CiphertextBlob: blob }));
    if (!out.Plaintext) {
      throw new Error('KMS decrypt failed');
    }
    return Buffer.from(out.Plaintext).toString('utf8');
  }
  const key = getLocalKey();
  const iv = blob.subarray(0, 12);
  const tag = blob.subarray(12, 28);
  const data = blob.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}
