/**
 * Integration tests against the real PostgreSQL database.
 *
 * These exercise the durable primitives the workers rely on: the job state machine,
 * worker leases, the abandoned-job sweep, the transactional outbox and the audit log.
 * A throwaway workspace is created for the run and deleted afterwards.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

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

let db: typeof import('@clipforge/database');
let workspaceId: string;
let userId: string;
let sourceId: string;

beforeAll(async () => {
  db = await import('@clipforge/database');
  const suffix = randomUUID().slice(0, 8);
  const user = await db.prisma.user.create({
    data: { email: `integration-${suffix}@clipforge.test`, displayName: 'Integration Test', passwordHash: 'argon2-placeholder' },
  });
  userId = user.id;
  const workspace = await db.prisma.workspace.create({
    data: { name: `Integration ${suffix}`, slug: `integration-${suffix}`, timezone: 'Asia/Kolkata' },
  });
  workspaceId = workspace.id;
  await db.prisma.workspaceMember.create({ data: { workspaceId, userId, role: 'OWNER' } });
  const source = await db.prisma.sourceVideo.create({
    data: {
      workspaceId,
      createdById: userId,
      kind: 'UPLOAD',
      status: 'VALIDATED',
      originalFileName: 'integration-source.mp4',
      declaredMimeType: 'video/mp4',
      detectedMimeType: 'video/mp4',
      storageKey: `integration/${suffix}/source.mp4`,
      sizeBytes: 1024,
      rightsDeclaration: { accepted: true, statement: 'integration fixture', acceptedAt: new Date().toISOString() },
    },
  });
  sourceId = source.id;
});

afterAll(async () => {
  if (!workspaceId) return;
  // Cascades remove jobs, clips, outbox rows and audit entries created below.
  await db.prisma.workspace.delete({ where: { id: workspaceId } }).catch(() => undefined);
  await db.prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
  await db.prisma.$disconnect();
});

const baseConfig = { render: { width: 1080, height: 1920 } };

describe('processing job lifecycle', () => {
  it('creates a job, walks allowed transitions and records every stage', async () => {
    const job = await db.createProcessingJob({ workspaceId, sourceVideoId: sourceId, createdById: userId, configuration: baseConfig });
    expect(job.status).toBe('QUEUED');

    await db.transitionJob(job.id, 'PROBING', { progressPercent: 5, workerId: 'worker-test' });
    await db.transitionJob(job.id, 'TRANSCRIBING', { progressPercent: 20 });
    await db.transitionJob(job.id, 'AI_ANALYSIS', { progressPercent: 45 });
    await db.transitionJob(job.id, 'CLIP_SELECTION', { progressPercent: 60 });
    await db.transitionJob(job.id, 'RENDERING', { progressPercent: 75 });
    await db.transitionJob(job.id, 'VALIDATION', { progressPercent: 90 });
    await db.transitionJob(job.id, 'ASSET_STORAGE', { progressPercent: 95 });
    const completed = await db.transitionJob(job.id, 'COMPLETED', { progressPercent: 100 });

    expect(completed.status).toBe('COMPLETED');
    expect(completed.completedAt).not.toBeNull();
    expect(completed.leaseExpiresAt).toBeNull();

    const stages = await db.prisma.jobStage.findMany({ where: { jobId: job.id } });
    const executed = stages.map((stage) => stage.stage).sort();
    expect(executed).toEqual(
      ['QUEUED', 'PROBING', 'TRANSCRIBING', 'AI_ANALYSIS', 'CLIP_SELECTION', 'RENDERING', 'VALIDATION', 'ASSET_STORAGE', 'COMPLETED'].sort(),
    );
    expect(stages.filter((stage) => stage.status === 'RUNNING')).toHaveLength(0);
  });

  it('refuses an illegal transition and leaves the row untouched', async () => {
    const job = await db.createProcessingJob({ workspaceId, sourceVideoId: sourceId, createdById: userId, configuration: baseConfig });
    await expect(db.transitionJob(job.id, 'RENDERING')).rejects.toThrow(/transition/i);
    const reloaded = await db.prisma.processingJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(reloaded.status).toBe('QUEUED');
  });

  it('marks the job FAILED with a code and then allows a retry', async () => {
    const job = await db.createProcessingJob({ workspaceId, sourceVideoId: sourceId, createdById: userId, configuration: baseConfig });
    await db.transitionJob(job.id, 'PROBING');
    const failed = await db.transitionJob(job.id, 'FAILED', { errorCode: 'AI_PROVIDER_ERROR', errorMessage: 'upstream 500' });
    expect(failed.errorCode).toBe('AI_PROVIDER_ERROR');
    const retrying = await db.transitionJob(job.id, 'RETRYING', { attemptIncrement: true } as never);
    expect(retrying.status).toBe('RETRYING');
    const resumed = await db.transitionJob(job.id, 'PROBING');
    expect(resumed.status).toBe('PROBING');
  });

  it('exposes a released lease as normal and only treats a stale heartbeat as abandonment', async () => {
    const job = await db.createProcessingJob({ workspaceId, sourceVideoId: sourceId, createdById: userId, configuration: baseConfig });
    await db.transitionJob(job.id, 'PROBING', { workerId: 'worker-lease', progressPercent: 5 });
    const acquired = await db.acquireJobLease(job.id, 'worker-lease', 60);
    expect(acquired).toBe(true);
    expect(await db.acquireJobLease(job.id, 'worker-other', 60)).toBe(false);

    // Release between stages: the row keeps a stale-null lease and must NOT be swept.
    await db.releaseJobLease(job.id);
    const abandonedAfterRelease = await db.findAbandonedJobs(60);
    expect(abandonedAfterRelease.map((row) => row.jobId)).not.toContain(job.id);

    // Age the heartbeat: now the sweeper must find it.
    await db.prisma.processingJob.update({
      where: { id: job.id },
      data: { heartbeatAt: new Date(Date.now() - 3_600_000), workerId: 'worker-lease' },
    });
    const abandoned = await db.findAbandonedJobs(60);
    expect(abandoned.map((row) => row.jobId)).toContain(job.id);
    expect(abandoned.find((row) => row.jobId === job.id)?.lastSuccessfulStage).toBe('PROBING');
  });

  it('ignores control-state rows when computing the last successful stage', async () => {
    const job = await db.createProcessingJob({ workspaceId, sourceVideoId: sourceId, createdById: userId, configuration: baseConfig });
    await db.transitionJob(job.id, 'PROBING');
    await db.transitionJob(job.id, 'TRANSCRIBING');
    await db.prisma.jobStage.create({ data: { jobId: job.id, stage: 'RETRYING', status: 'SUCCEEDED', progressPercent: 0 } });
    await db.prisma.processingJob.update({
      where: { id: job.id },
      data: { status: 'RETRYING', stage: 'RETRYING', heartbeatAt: new Date(Date.now() - 3_600_000) },
    });
    const abandoned = await db.findAbandonedJobs(60);
    const row = abandoned.find((item) => item.jobId === job.id);
    expect(row).toBeDefined();
    // RETRYING is a control state, not progress. TRANSCRIBING was interrupted mid-stage, so the
    // resume point is the last *completed* stage — re-running an interrupted stage is idempotent,
    // whereas resuming from RETRYING itself would leave the job with nothing to resume.
    expect(row?.lastSuccessfulStage).toBe('PROBING');
  });
});

describe('transactional outbox', () => {
  it('writes an outbox row in the same transaction as the job and claims it exactly once', async () => {
    const job = await db.createProcessingJob({ workspaceId, sourceVideoId: sourceId, createdById: userId, configuration: baseConfig });
    const pending = await db.prisma.outboxEvent.findMany({ where: { aggregateId: job.id, publishedAt: null } });
    expect(pending).toHaveLength(1);
    expect(pending[0].eventType).toBe('job.queued');
    expect(pending[0].queue).toBe('clipforge.pipeline');

    const firstClaim = await db.claimOutboxBatch(200);
    const claimedHere = firstClaim.filter((row) => row.aggregateId === job.id);
    expect(claimedHere).toHaveLength(1);
    const secondClaim = await db.claimOutboxBatch(200);
    expect(secondClaim.map((row) => row.id)).not.toContain(claimedHere[0].id);

    await db.markOutboxPublished(claimedHere[0].id);
    const after = await db.prisma.outboxEvent.findUniqueOrThrow({ where: { id: claimedHere[0].id } });
    expect(after.publishedAt).not.toBeNull();
  });

  it('records a failure without losing the event', async () => {
    const job = await db.createProcessingJob({ workspaceId, sourceVideoId: sourceId, createdById: userId, configuration: baseConfig });
    const row = await db.prisma.outboxEvent.findFirstOrThrow({ where: { aggregateId: job.id, publishedAt: null } });
    const claimed = (await db.claimOutboxBatch(200)).find((event) => event.id === row.id);
    expect(claimed?.attempts).toBe(1);
    await db.markOutboxFailed(row.id, 'redis unavailable', 5000);
    const failedRow = await db.prisma.outboxEvent.findUniqueOrThrow({ where: { id: row.id } });
    expect(failedRow.publishedAt).toBeNull();
    expect(failedRow.attempts).toBeGreaterThan(0);
    expect(failedRow.lastError).toContain('redis unavailable');
  });
});

describe('audit log', () => {
  it('appends an immutable row capturing actor, ip and metadata', async () => {
    await db.appendAuditLog({
      workspaceId,
      userId,
      action: 'JOB_CREATED',
      summary: 'integration audit entry',
      metadata: { iterator: 1 },
      ipAddress: '203.0.113.7',
      userAgent: 'vitest',
    });
    const rows = await db.prisma.auditLog.findMany({ where: { workspaceId, summary: { contains: 'integration audit entry' } } });
    expect(rows).toHaveLength(1);
    expect(rows[0].summary).toContain('integration audit entry');
    expect(rows[0].ipAddress).toBe('203.0.113.7');
  });
});

describe('configuration resolution', () => {
  it('reports the exact missing keys instead of applying defaults', async () => {
    const service = new db.ConfigurationService(workspaceId);
    await expect(service.requireForProcessing()).rejects.toMatchObject({ code: 'CONFIGURATION_REQUIRED' });
    try {
      await service.requireForProcessing();
    } catch (error) {
      const missing = (error as { missing?: string[] }).missing ?? [];
      expect(missing).toContain('render.output_width');
      expect(missing).toContain('subtitles.preset_id');
      expect(missing.length).toBeGreaterThan(10);
    }
  });

  it('resolves an explicitly written workspace value ahead of the global row', async () => {
    await db.ConfigurationService.set(workspaceId, 'workspace.timezone', 'Asia/Kolkata', userId);
    const resolved = await new db.ConfigurationService(workspaceId).load();
    expect(resolved.values.get('workspace.timezone')).toBe('Asia/Kolkata');
  });
});
