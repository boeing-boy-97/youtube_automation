import { Injectable, Logger } from '@nestjs/common';
import { ConfigurationService, prisma } from '@clipforge/database';
import { env } from '../common/env';
import { RedisService } from '../common/services/redis.service';
import { QueueService } from '../queues/queue.service';
import { StorageService } from '../storage/storage.service';

export interface ComponentHealth {
  component: string;
  status: 'healthy' | 'degraded' | 'down' | 'unconfigured';
  message: string;
  latencyMs?: number;
  details?: Record<string, unknown>;
}

@Injectable()
export class SystemService {
  private readonly logger = new Logger(SystemService.name);

  constructor(
    private readonly redis: RedisService,
    private readonly queues: QueueService,
    private readonly storage: StorageService,
  ) {}

  async databaseHealth(): Promise<ComponentHealth> {
    const started = Date.now();
    try {
      const [{ count }] = await prisma.$queryRaw<Array<{ count: bigint }>>`SELECT count(*)::bigint AS count FROM "ProcessingJob"`;
      return {
        component: 'postgres',
        status: 'healthy',
        message: 'Query succeeded',
        latencyMs: Date.now() - started,
        details: { processingJobs: Number(count) },
      };
    } catch (error) {
      return { component: 'postgres', status: 'down', message: (error as Error).message };
    }
  }

  async redisHealth(): Promise<ComponentHealth> {
    const started = Date.now();
    try {
      const pong = await this.redis.client.ping();
      return { component: 'redis', status: pong === 'PONG' ? 'healthy' : 'degraded', message: `PING -> ${pong}`, latencyMs: Date.now() - started };
    } catch (error) {
      return { component: 'redis', status: 'down', message: (error as Error).message };
    }
  }

  async storageHealth(): Promise<ComponentHealth> {
    const driver = this.storage.driver;
    try {
      const key = `health/${new Date().toISOString().slice(0, 10)}.txt`;
      await this.storage.putBuffer(key, Buffer.from('clipforge storage probe'), 'text/plain');
      const exists = await this.storage.exists(key);
      await this.storage.delete(key);
      const publicCheck = await this.storage.expectPublicHttps();
      return {
        component: 'storage',
        status: exists ? 'healthy' : 'degraded',
        message: `${driver} driver ${exists ? 'read/write OK' : 'write verification failed'}${publicCheck.ok ? '' : ` — ${publicCheck.reason}`}`,
        details: { driver, publicHttps: publicCheck.ok },
      };
    } catch (error) {
      return { component: 'storage', status: 'down', message: (error as Error).message, details: { driver } };
    }
  }

  async aiEngineHealth(): Promise<ComponentHealth> {
    const started = Date.now();
    try {
      const response = await fetch(`${env.AI_ENGINE_URL}/health`, { headers: { 'x-api-key': env.AI_ENGINE_API_KEY } });
      const body = (await response.json()) as { status?: string; geminiConfigured?: boolean; whisperModel?: string };
      const geminiOk = body.geminiConfigured === true;
      return {
        component: 'ai-engine',
        status: response.ok ? (geminiOk ? 'healthy' : 'unconfigured') : 'down',
        message: response.ok
          ? geminiOk
            ? `Ready (whisper=${body.whisperModel})`
            : 'Service is running but GEMINI_API_KEY/model configuration is missing'
          : `HTTP ${response.status}`,
        latencyMs: Date.now() - started,
        details: body as Record<string, unknown>,
      };
    } catch (error) {
      return { component: 'ai-engine', status: 'down', message: (error as Error).message };
    }
  }

  async videoProcessorHealth(): Promise<ComponentHealth> {
    const started = Date.now();
    try {
      const response = await fetch(`${env.VIDEO_PROCESSOR_URL}/health`, { headers: { 'x-api-key': env.VIDEO_PROCESSOR_API_KEY } });
      const body = (await response.json()) as { ffmpeg?: string; ffprobe?: string };
      return {
        component: 'video-processor',
        status: response.ok ? 'healthy' : 'down',
        message: response.ok ? `FFmpeg ${body.ffmpeg ?? 'unknown'}` : `HTTP ${response.status}`,
        latencyMs: Date.now() - started,
        details: body as Record<string, unknown>,
      };
    } catch (error) {
      return { component: 'video-processor', status: 'down', message: (error as Error).message };
    }
  }

  integrationHealth(): ComponentHealth[] {
    const status = ConfigurationService.integrationStatus();
    return [
      {
        component: 'gemini',
        status: status.gemini ? 'healthy' : 'unconfigured',
        message: status.gemini ? 'GEMINI_API_KEY and both models are set' : 'Awaiting GEMINI_API_KEY, GEMINI_TEXT_MODEL and GEMINI_VISION_MODEL',
      },
      {
        component: 'youtube',
        status: status.youtube ? 'healthy' : 'unconfigured',
        message: status.youtube ? 'YouTube OAuth client is configured' : 'Awaiting YOUTUBE_CLIENT_ID / CLIENT_SECRET / REDIRECT_URI',
      },
      {
        component: 'instagram',
        status: status.instagram ? 'healthy' : 'unconfigured',
        message: status.instagram
          ? `Instagram app configured (Graph ${env.META_GRAPH_API_VERSION})`
          : 'Awaiting META_APP_ID / APP_SECRET / REDIRECT_URI / GRAPH_API_VERSION',
      },
    ];
  }

  /** Worker presence is derived from Redis heartbeats renewed by each worker. */
  async workers(): Promise<{ workers: Array<{ role: string; workerId: string; lastHeartbeatAgoSeconds: number; alive: boolean; concurrency?: number }> }> {
    const pattern = this.redis.key('worker', '*');
    const keys = await this.redis.client.keys(pattern);
    const workers = [];
    for (const key of keys) {
      const raw = await this.redis.client.get(key);
      if (!raw) continue;
      const parsed = JSON.parse(raw) as { role: string; workerId: string; concurrency?: number; updatedAt: string };
      const age = (Date.now() - new Date(parsed.updatedAt).getTime()) / 1000;
      workers.push({
        // Heartbeats are written as `worker:<role>`; strip the prefix so both the API and the UI
        // speak in roles ("render", not "worker:render"). A prefix mismatch here once made the
        // diagnostics report every healthy worker as missing.
        role: parsed.role.replace(/^worker:/, ''),
        workerId: parsed.workerId,
        concurrency: parsed.concurrency,
        lastHeartbeatAgoSeconds: Math.round(age),
        alive: age < 60,
      });
    }
    return { workers: workers.sort((a, b) => a.role.localeCompare(b.role)) };
  }

  async readiness() {
    const [db, redis, storage, ai, vp] = await Promise.all([
      this.databaseHealth(),
      this.redisHealth(),
      this.storageHealth(),
      this.aiEngineHealth(),
      this.videoProcessorHealth(),
    ]);
    const integration = this.integrationHealth();
    const workers = await this.workers();
    const blocking = [db, redis, storage].filter((c) => c.status === 'down');
    const processingBlockers = [ai, vp].filter((c) => c.status !== 'healthy');
    return {
      ready: blocking.length === 0,
      processingReady: blocking.length === 0 && processingBlockers.length === 0 && integration.find((c) => c.component === 'gemini')?.status === 'healthy',
      components: { db, redis, storage, ai, vp, integration },
      workers: workers.workers,
    };
  }

  async health() {
    const [db, redis] = await Promise.all([this.databaseHealth(), this.redisHealth()]);
    const healthy = db.status === 'healthy' && redis.status === 'healthy';
    return { status: healthy ? 'ok' : 'degraded', uptimeSeconds: Math.round(process.uptime()), version: process.env.npm_package_version ?? '1.0.0', checks: [db, redis] };
  }

  async systemOverview(workspaceId: string) {
    const [readiness, depths, workers, counts] = await Promise.all([
      this.readiness(),
      this.queues.depths(),
      this.workers(),
      this.counts(workspaceId),
    ]);
    const healthEvents = await prisma.systemHealthEvent.findMany({ orderBy: { observedAt: 'desc' }, take: 20 });
    return {
      readiness,
      queues: depths,
      workers: workers.workers,
      counts,
      healthEvents: healthEvents.map((e) => ({
        id: e.id,
        component: e.component,
        severity: e.severity,
        status: e.status,
        message: e.message,
        observedAt: e.observedAt.toISOString(),
      })),
      storage: { driver: this.storage.driver, publicUrlConfigured: (await this.storage.expectPublicHttps()).ok },
      graphApiVersion: env.META_GRAPH_API_VERSION ?? null,
      timezone: env.TIMEZONE,
      uptimeSeconds: Math.round(process.uptime()),
    };
  }

  async counts(workspaceId: string) {
    const [sources, clips, published, processing, failed, publishingFailed, pendingJobs] = await Promise.all([
      prisma.sourceVideo.count({ where: { workspaceId, deletedAt: null } }),
      prisma.generatedClip.count({ where: { workspaceId } }),
      prisma.publishedPost.count({ where: { workspaceId } }),
      prisma.processingJob.count({ where: { workspaceId, status: { notIn: ['COMPLETED', 'FAILED', 'CANCELLED', 'PARTIALLY_COMPLETED'] } } }),
      prisma.processingJob.count({ where: { workspaceId, status: 'FAILED' } }),
      prisma.publishingJob.count({ where: { workspaceId, status: 'FAILED' } }),
      prisma.publishingJob.count({ where: { workspaceId, status: { in: ['PENDING', 'QUEUED', 'UPLOADING', 'AWAITING_PLATFORM'] } } }),
    ]);
    return { sources, clips, published, processing, failed, publishingFailed, pendingPublishingJobs: pendingJobs };
  }

  /** Dashboard: real database values only, no synthetic analytics. */
  async dashboard(workspaceId: string) {
    const counts = await this.counts(workspaceId);
    const [recentJobs, recentClips, recentActivity, publishedByPlatform, variantBreakdown] = await Promise.all([
      prisma.processingJob.findMany({
        where: { workspaceId },
        orderBy: { createdAt: 'desc' },
        take: 6,
        include: { sourceVideo: { select: { originalFileName: true, durationSeconds: true } } },
      }),
      prisma.generatedClip.findMany({ where: { workspaceId }, orderBy: { createdAt: 'desc' }, take: 6 }),
      prisma.auditLog.findMany({ where: { workspaceId }, orderBy: { createdAt: 'desc' }, take: 12 }),
      prisma.publishedPost.groupBy({ by: ['platform'], where: { workspaceId }, _count: { _all: true } }),
      prisma.generatedClip.groupBy({ by: ['durationKind'], where: { workspaceId }, _count: { _all: true } }),
    ]);
    return {
      counts,
      publishedByPlatform: publishedByPlatform.map((p) => ({ platform: p.platform, count: p._count._all })),
      variantBreakdown: variantBreakdown.map((v) => ({ durationKind: v.durationKind, count: v._count._all })),
      recentJobs: recentJobs.map((job) => ({
        id: job.id,
        status: job.status,
        stage: job.stage,
        progressPercent: job.progressPercent,
        createdAt: job.createdAt.toISOString(),
        fileName: job.sourceVideo.originalFileName,
        durationSeconds: job.sourceVideo.durationSeconds,
      })),
      recentClips: recentClips.map((clip) => ({
        id: clip.id,
        title: clip.title,
        durationKind: clip.durationKind,
        qualityScore: clip.qualityScore,
        status: clip.status,
        createdAt: clip.createdAt.toISOString(),
      })),
      recentActivity: recentActivity.map((log) => ({
        id: log.id,
        action: log.action,
        summary: log.summary,
        createdAt: log.createdAt.toISOString(),
      })),
    };
  }

  async systemEvents(workspaceId: string | null, limit = 50) {
    return prisma.systemHealthEvent.findMany({
      where: workspaceId ? { OR: [{ workspaceId }, { workspaceId: null }] } : { workspaceId: null },
      orderBy: { observedAt: 'desc' },
      take: limit,
    });
  }
}
