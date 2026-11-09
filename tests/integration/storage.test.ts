/**
 * Integration tests for the local storage driver's byte-exact behaviour.
 *
 * Both cases are regressions from a real defect: ranged reads that ignored the offset, and
 * multipart uploads that appended in arrival order.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function loadEnv() {
  const text = readFileSync(new URL('../../.env', import.meta.url), 'utf8');
  for (const line of text.split('\n')) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!match) continue;
    const value = match[2].trim().replace(/^"|"$/g, '');
    if (process.env[match[1]] === undefined) process.env[match[1]] = value;
  }
}
loadEnv();

let StorageService: typeof import('../../apps/api/src/storage/storage.service').StorageService;
let storage: InstanceType<typeof StorageService>;
let workDir: string;

beforeAll(async () => {
  process.env.STORAGE_DRIVER = process.env.STORAGE_DRIVER ?? 'local';
  ({ StorageService } = await import('../../apps/api/src/storage/storage.service'));
  storage = new StorageService();
  workDir = await mkdtemp(join(tmpdir(), 'clipforge-storage-'));
});

afterAll(async () => {
  if (workDir) await rm(workDir, { recursive: true, force: true });
});

async function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

describe('ranged reads', () => {
  it('returns the requested byte window, not the head of the file', async () => {
    const payload = Buffer.alloc(4096);
    for (let index = 0; index < payload.length; index += 1) payload[index] = index % 251;
    const key = `tests/${randomUUID()}/object.bin`;
    await storage.putBuffer(key, payload, 'application/octet-stream');

    expect(await storage.statSize(key)).toBe(payload.length);
    const ranged = await storage.getStreamRange(key, 1000, 1099);
    expect(ranged.contentLength).toBe(100);
    const served = await collect(ranged.stream);
    expect(served.length).toBe(100);
    expect(createHash('sha256').update(served).digest('hex')).toBe(
      createHash('sha256').update(payload.subarray(1000, 1100)).digest('hex'),
    );
  });

  it('clamps a range that runs past the end of the object', async () => {
    const payload = Buffer.from('0123456789');
    const key = `tests/${randomUUID()}/short.bin`;
    await storage.putBuffer(key, payload, 'application/octet-stream');
    const ranged = await storage.getStreamRange(key, 5, 999);
    const served = await collect(ranged.stream);
    expect(served.toString()).toBe('56789');
  });
});

describe('multipart parts', () => {
  it('is order-independent and idempotent for retried parts', async () => {
    const declared = Buffer.alloc(48);
    for (let index = 0; index < declared.length; index += 1) declared[index] = index;
    const stagingPath = join(workDir, 'order.part');

    // Parts arrive 3, 1, 3 again, 2 — deliberately out of order with a retry.
    await storage.writeLocalPartAt(stagingPath, 32, declared.subarray(32, 48));
    await storage.writeLocalPartAt(stagingPath, 0, declared.subarray(0, 16));
    await storage.writeLocalPartAt(stagingPath, 32, declared.subarray(32, 48));
    const size = await storage.writeLocalPartAt(stagingPath, 16, declared.subarray(16, 32));

    expect(size).toBe(declared.length);
    const onDisk = readFileSync(stagingPath);
    expect(createHash('sha256').update(onDisk).digest('hex')).toBe(createHash('sha256').update(declared).digest('hex'));
  });
});
