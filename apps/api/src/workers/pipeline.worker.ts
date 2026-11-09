/**
 * Pipeline worker — owns stages PROBING → TRANSCRIBING → AI_ANALYSIS →
 * CLIP_SELECTION → RENDERING hand-off.
 *
 * Durability: every stage transition is a committed database row before the work
 * starts, so a crash resumes from the last successful stage and never re-does
 * expensive work silently.
 */
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { prisma, transitionJob, acquireJobLease, writeOutbox, releaseJobLease, appendAuditLog } from '@clipforge/database';
import type { Prisma } from '@prisma/client';
import { env } from '../common/env';
import { AppConfigService } from '../common/services/config.service';
import { estimateCostUsd } from '../common/services/usage-cost';
import { StorageService } from '../storage/storage.service';
import { createRuntime, createWorker, wireShutdown, startLeaseRenewal } from './base';
import { aiEngine, videoProcessor, ServiceCallError } from './services-client';

const runtime = createRuntime('ai', env.WORKER_CONCURRENCY_AI);
const storage = new StorageService();
const appConfig = new AppConfigService();

interface JobConfiguration {
  framingMode: 'face_track' | 'center_crop' | 'manual' | 'background_blur';
  framingFallback: 'center_crop' | 'background_blur' | 'fail';
  subtitlePresetId: string;
  subtitleLanguage: string;
  contentLanguages: string[];
  targetDurations: number[];
  maxClips: number;
  minQualityScore: number;
  autoPublish: boolean;
  platforms: Array<'YOUTUBE' | 'INSTAGRAM'>;
  brandProfileId?: string;
  manualOffsetX?: number;
  resolved?: Record<string, unknown>;
  subtitlePresetStyle?: Record<string, unknown>;
}

async function handler(job: { id?: string; data: { jobId: string; resumeFrom?: string } }): Promise<void> {
  const jobId = job.data.jobId;
  const leased = await acquireJobLease(jobId, runtime.workerId, env.JOB_LEASE_SECONDS);
  if (!leased) {
    runtime.logger.info(`job ${jobId} is owned by another worker (or finished) — skipping`);
    return;
  }
  const stopRenewal = startLeaseRenewal(jobId, runtime.workerId, runtime.logger);
  try {
    await runPipeline(jobId);
  } finally {
    stopRenewal();
    await releaseJobLease(jobId).catch(() => undefined);
  }
}

async function runPipeline(jobId: string): Promise<void> {
  const job = await prisma.processingJob.findUnique({
    where: { id: jobId },
    include: { sourceVideo: true, stages: true },
  });
  if (!job) throw new Error(`Job ${jobId} not found`);
  if (['CANCELLED', 'COMPLETED', 'FAILED', 'PARTIALLY_COMPLETED'].includes(job.status)) {
    runtime.logger.info(`job ${jobId} is ${job.status}; nothing to do`);
    return;
  }

  const configuration = job.configuration as unknown as JobConfiguration;
  const workDir = join(env.WORK_DIR, jobId);
  await mkdir(workDir, { recursive: true });
  const sourcePath = join(workDir, `source-${job.sourceVideoId}.mp4`);

  try {
    // Resolve configuration again at execution time: a job must never run with
    // stale limits if the workspace configuration was changed or removed.
    const liveConfig = await appConfig.resolveForProcessing(job.workspaceId);

    const completedStages = new Set(job.stages.filter((stage) => stage.status === 'SUCCEEDED').map((stage) => stage.stage));

    // ------------------------------- PROBING ---------------------------------
    if (!completedStages.has('PROBING')) {
      await transitionJob(jobId, 'PROBING', {
        workerId: runtime.workerId,
        progressPercent: 5,
        progressDetail: 'Inspecting source media with ffprobe',
        leaseSeconds: env.JOB_LEASE_SECONDS,
      });
      if (!job.sourceVideo.storageKey) throw new Error('Source has no stored object');
      await storage.downloadToFile(job.sourceVideo.storageKey, sourcePath);
      const probe = await videoProcessor.probe(sourcePath);
      await prisma.sourceVideo.update({
        where: { id: job.sourceVideoId },
        data: {
          durationSeconds: probe.duration_seconds,
          width: probe.width,
          height: probe.height,
          frameRate: probe.frame_rate,
          probeResult: probe as unknown as Prisma.InputJsonValue,
        },
      });
      await transitionJob(jobId, 'TRANSCRIBING', {
        workerId: runtime.workerId,
        progressPercent: 12,
        progressDetail: `Probed ${probe.width}x${probe.height}, ${probe.duration_seconds.toFixed(1)}s`,
        leaseSeconds: env.JOB_LEASE_SECONDS,
      });
    }

    // ----------------------------- TRANSCRIBING ------------------------------
    let transcript = await prisma.transcript.findFirst({
      where: { jobId },
      include: { segments: { orderBy: { sequence: 'asc' } } },
    });
    if (!transcript) {
      await ensureStatus(jobId, 'TRANSCRIBING');
      const result = await aiEngine.transcribe({
        job_id: jobId,
        video_path: sourcePath,
        language: configuration.subtitleLanguage,
      });
      const transcription = result.transcription;
      transcript = await prisma.transcript.create({
        data: {
          workspaceId: job.workspaceId,
          sourceVideoId: job.sourceVideoId,
          jobId,
          language: transcription.language,
          languageProbability: transcription.language_probability,
          provider: transcription.provider,
          model: transcription.model,
          wordTimestamps: transcription.word_timestamps,
          durationSeconds: transcription.duration_seconds,
          fullText: transcription.full_text,
          metadata: { words: transcription.segments.reduce((acc, s) => acc + s.words.length, 0) } as Prisma.InputJsonValue,
          segments: {
            create: transcription.segments.map((segment) => ({
              sequence: segment.sequence,
              startSeconds: segment.start,
              endSeconds: segment.end,
              text: segment.text,
              speakerLabel: null,
              avgLogprob: segment.avg_logprob,
              noSpeechProb: segment.no_speech_prob,
              words: segment.words as unknown as Prisma.InputJsonValue,
            })),
          },
        },
        include: { segments: { orderBy: { sequence: 'asc' } } },
      });
      const transcriptionMetadata = { model: transcription.model, provider: transcription.provider };
      await prisma.usageRecord.create({
        data: {
          workspaceId: job.workspaceId,
          jobId,
          kind: 'transcription_seconds',
          quantity: transcription.duration_seconds,
          unit: 'seconds',
          metadata: transcriptionMetadata,
          costUsd: estimateCostUsd('transcription_seconds', transcription.duration_seconds, transcriptionMetadata),
        },
      });
      await transitionJob(jobId, 'AI_ANALYSIS', {
        workerId: runtime.workerId,
        progressPercent: 30,
        progressDetail: `${transcription.segments.length} transcript segments (${transcription.language})`,
        leaseSeconds: env.JOB_LEASE_SECONDS,
      });
    } else {
      await ensureStatus(jobId, 'AI_ANALYSIS');
    }

    // ------------------------------ AI_ANALYSIS ------------------------------
    const transcriptPayload = {
      language: transcript.language,
      language_probability: transcript.languageProbability,
      duration_seconds: transcript.durationSeconds ?? job.sourceVideo.durationSeconds ?? 0,
      provider: transcript.provider,
      model: transcript.model,
      word_timestamps: transcript.wordTimestamps,
      full_text: transcript.fullText,
      segments: transcript.segments.map((segment) => ({
        sequence: segment.sequence,
        start: segment.startSeconds,
        end: segment.endSeconds,
        text: segment.text,
        words: segment.words as unknown as Array<{ word: string; start: number; end: number; probability: number }>,
        avg_logprob: segment.avgLogprob,
        no_speech_prob: segment.noSpeechProb,
      })),
    };

    const analysis = await aiEngine.analyze({
      job_id: jobId,
      video_path: sourcePath,
      text_model: liveConfig.aiTextModel,
      vision_model: liveConfig.aiVisionModel,
      target_durations: configuration.targetDurations,
      max_candidates: liveConfig.maxCandidatesPerCall,
      max_clips: Math.min(configuration.maxClips, liveConfig.maxOutputClips),
      min_quality_score: configuration.minQualityScore,
      duplicate_threshold: liveConfig.duplicateThreshold,
      language: configuration.subtitleLanguage,
      enable_vision: true,
      transcript: transcriptPayload,
    });

    // Text and vision calls are priced separately: vision batches dominate prompt tokens, and
    // lumping them together hides which stage is expensive.
    const usage = analysis.report.usage as
      | {
          total_tokens?: number;
          text?: { prompt_tokens?: number; candidate_tokens?: number; total_tokens?: number };
          vision?: { prompt_tokens?: number; candidate_tokens?: number; total_tokens?: number; calls?: number };
        }
      | undefined;
    const textTokens = usage?.text?.total_tokens ?? 0;
    if (textTokens > 0) {
      const metadata = {
        model: liveConfig.aiTextModel,
        promptTokens: usage?.text?.prompt_tokens ?? 0,
        candidateTokens: usage?.text?.candidate_tokens ?? 0,
      };
      await prisma.usageRecord.create({
        data: {
          workspaceId: job.workspaceId,
          jobId,
          kind: 'gemini_tokens',
          quantity: textTokens,
          unit: 'tokens',
          metadata,
          costUsd: estimateCostUsd('gemini_tokens', textTokens, metadata),
        },
      });
    }
    const visionTokens = usage?.vision?.total_tokens ?? 0;
    if (visionTokens > 0) {
      const metadata = {
        model: liveConfig.aiVisionModel,
        promptTokens: usage?.vision?.prompt_tokens ?? 0,
        candidateTokens: usage?.vision?.candidate_tokens ?? 0,
        calls: usage?.vision?.calls ?? 0,
      };
      await prisma.usageRecord.create({
        data: {
          workspaceId: job.workspaceId,
          jobId,
          kind: 'gemini_vision_tokens',
          quantity: visionTokens,
          unit: 'tokens',
          metadata,
          costUsd: estimateCostUsd('gemini_vision_tokens', visionTokens, metadata),
        },
      });
    }

    // ----------------------------- CLIP_SELECTION -----------------------------
    await ensureStatus(jobId, 'CLIP_SELECTION');
    await prisma.highlightCandidate.deleteMany({ where: { jobId } });
    await prisma.generatedClip.deleteMany({ where: { jobId } });

    if (analysis.plan.length === 0) {
      const explanation =
        (analysis.report.explanation as string | undefined) ??
        'No candidate met the configured quality threshold after validation and duplicate suppression.';
      await transitionJob(jobId, 'COMPLETED', {
        progressPercent: 100,
        progressDetail: `No clips produced: ${explanation}`.slice(0, 500),
        resultSummary: {
          outcome: 'NO_QUALITY_CANDIDATES',
          explanation,
          report: analysis.report,
          variantDecisions: analysis.variant_decisions,
        } as Prisma.InputJsonValue,
        workerId: runtime.workerId,
      });
      await appendAuditLog({
        workspaceId: job.workspaceId,
        userId: job.createdById,
        action: 'JOB_STAGE_CHANGED',
        targetType: 'ProcessingJob',
        targetId: jobId,
        summary: `Job finished with no clips: ${explanation}`.slice(0, 400),
      });
      return;
    }

    const brandProfile = configuration.brandProfileId
      ? await prisma.brandProfile.findFirst({ where: { id: configuration.brandProfileId, workspaceId: job.workspaceId } })
      : await prisma.brandProfile.findFirst({ where: { workspaceId: job.workspaceId, isDefault: true } });

    const captionResponse = await aiEngine.captions({
      model: liveConfig.aiTextModel,
      brand_voice: brandProfile?.brandVoice ?? null,
      audience: brandProfile?.audienceDescription ?? null,
      language: configuration.subtitleLanguage,
      source_context: transcript.fullText.slice(0, 4000),
      clips: analysis.plan.map((entry, index) => ({
        clip_id: `${jobId}-${index}`,
        transcript: entry.candidate.transcript,
        hook: String(entry.candidate.hook ?? ''),
        content_category: String(entry.candidate.content_category ?? 'educational'),
      })),
    });

    const clipIds: string[] = [];
    for (const [index, entry] of analysis.plan.entries()) {
      const candidate = entry.candidate as unknown as {
        start_time: number;
        end_time: number;
        target_duration: number;
        hook: string;
        reason: string;
        transcript: string;
        content_category: string;
        quality_score: number;
        confidence: number;
        visual_context: string;
        scores: Record<string, number>;
      };

      const highlight = await prisma.highlightCandidate.create({
        data: {
          workspaceId: job.workspaceId,
          jobId,
          transcriptId: transcript.id,
          startSeconds: candidate.start_time,
          endSeconds: candidate.end_time,
          targetDuration: candidate.target_duration,
          hook: candidate.hook,
          reason: candidate.reason,
          transcriptText: candidate.transcript,
          contentCategory: candidate.content_category,
          qualityScore: candidate.quality_score,
          confidence: candidate.confidence,
          visualContext: entry.visual_context ?? candidate.visual_context,
          scores: candidate.scores as unknown as Prisma.InputJsonValue,
          status: 'ACCEPTED',
          modelMetadata: { derived: entry.derived, derivationNote: entry.derivation_note ?? null },
        },
      });

      const clip = await prisma.generatedClip.create({
        data: {
          workspaceId: job.workspaceId,
          jobId,
          candidateId: highlight.id,
          title: `${candidate.hook || candidate.transcript.slice(0, 60)}`.slice(0, 120),
          contentCategory: candidate.content_category,
          qualityScore: candidate.quality_score,
          status: 'PLANNED',
          startSeconds: entry.start_time,
          endSeconds: entry.end_time,
          durationKind: entry.duration_kind,
        },
      });
      clipIds.push(clip.id);

      const metadata = captionResponse.results.find((result) => result.clipId === `${jobId}-${index}`);
      if (metadata?.ok && metadata.metadata) {
        const yt = metadata.metadata.youtube ?? {};
        const ig = metadata.metadata.instagram ?? {};
        await prisma.clipMetadata.createMany({
          data: [
            {
              clipId: clip.id,
              platform: 'YOUTUBE',
              title: String(yt.title ?? clip.title).slice(0, 100),
              description: String(yt.description ?? '').slice(0, 5000),
              hashtags: (yt.hashtags ?? []) as string[],
              tags: (yt.tags ?? []) as string[],
              language: configuration.subtitleLanguage,
              brandVoice: brandProfile?.brandVoice ?? null,
              model: String(metadata.metadata.model ?? liveConfig.aiTextModel),
              reviewStatus: 'DRAFT',
            },
            {
              clipId: clip.id,
              platform: 'INSTAGRAM',
              title: null,
              description: String(ig.caption ?? '').slice(0, 5000),
              hashtags: (ig.hashtags ?? []) as string[],
              tags: [],
              language: configuration.subtitleLanguage,
              brandVoice: brandProfile?.brandVoice ?? null,
              model: String(metadata.metadata.model ?? liveConfig.aiTextModel),
              reviewStatus: 'DRAFT',
            },
          ],
        });
      } else {
        runtime.logger.warn(`caption generation failed for clip ${clip.id}: ${metadata?.error ?? 'unknown'}`);
      }
    }

    // ------------------------------- RENDERING --------------------------------
    await transitionJob(jobId, 'RENDERING', {
      workerId: runtime.workerId,
      progressPercent: 45,
      progressDetail: `${clipIds.length} clip(s) queued for vertical rendering`,
      resultSummary: {
        report: analysis.report,
        variantDecisions: analysis.variant_decisions,
        rejectedCandidates: analysis.rejected_candidates.length,
        duplicatesDropped: analysis.duplicates_dropped.length,
      } as Prisma.InputJsonValue,
      leaseSeconds: env.JOB_LEASE_SECONDS,
    });

    await prisma.$transaction(async (tx) => {
      for (const clipId of clipIds) {
        await writeOutbox(tx, {
          aggregateType: 'GeneratedClip',
          aggregateId: clipId,
          eventType: 'clip.render',
          queue: 'clipforge.render',
          payload: { clipId, jobId },
        });
      }
    });
  } catch (error) {
    const serviceError = error instanceof ServiceCallError ? error : null;
    const retryable = serviceError ? serviceError.retryable : true;
    const message = error instanceof Error ? error.message : String(error);
    const attempt = job.attempt;
    const exhausted = !retryable || attempt >= job.maxAttempts;

    await transitionJob(jobId, exhausted ? 'FAILED' : 'RETRYING', {
      errorCode: serviceError?.code ?? 'PIPELINE_ERROR',
      errorMessage: message.slice(0, 1800),
      errorDetails: { stage: job.stage, retryable, attempt } as Prisma.InputJsonValue,
      progressDetail: exhausted ? `Failed: ${message}`.slice(0, 400) : `Retrying: ${message}`.slice(0, 400),
      workerId: runtime.workerId,
    });
    if (!exhausted) {
      // Re-enqueue from the last successful stage via the outbox (durable).
      await prisma.$transaction(async (tx) => {
        await writeOutbox(tx, {
          aggregateType: 'ProcessingJob',
          aggregateId: jobId,
          eventType: 'job.retry',
          queue: 'clipforge.pipeline',
          payload: { jobId },
          availableAt: new Date(Date.now() + 15_000 * attempt),
        });
      });
    }
    throw error;
  }
}

async function ensureStatus(jobId: string, expected: string): Promise<void> {
  const job = await prisma.processingJob.findUnique({ where: { id: jobId }, select: { status: true } });
  if (!job) throw new Error(`Job ${jobId} disappeared`);
  if (['CANCELLED', 'FAILED', 'COMPLETED', 'PARTIALLY_COMPLETED'].includes(job.status)) {
    throw new Error(`Job ${jobId} is ${job.status}; aborting stage`);
  }
  if (job.status !== expected) {
    // Legal re-entry after a retry: move to the expected stage explicitly.
    await transitionJob(jobId, expected as never, { workerId: runtime.workerId, leaseSeconds: env.JOB_LEASE_SECONDS });
  }
}

async function main() {
  const worker = createWorker('clipforge.pipeline', runtime, handler, env.WORKER_CONCURRENCY_AI);
  wireShutdown(runtime, [worker]);
  runtime.logger.info(`pipeline worker ready (concurrency=${env.WORKER_CONCURRENCY_AI})`);
}

void main();
