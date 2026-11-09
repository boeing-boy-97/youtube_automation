/**
 * Typed clients for the Python services. Every call has a timeout and surfaces
 * the service's structured error instead of swallowing it.
 */
import { env } from '../common/env';

export class ServiceCallError extends Error {
  constructor(
    message: string,
    readonly service: 'ai-engine' | 'video-processor',
    readonly status: number,
    readonly code: string,
    readonly retryable: boolean,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

async function post<T>(
  service: 'ai-engine' | 'video-processor',
  baseUrl: string,
  apiKey: string,
  path: string,
  body: unknown,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    const parsed = text ? safeJson(text) : {};
    if (!response.ok) {
      const detail = (parsed as { detail?: unknown }).detail;
      const record = (typeof detail === 'object' && detail !== null ? detail : {}) as Record<string, unknown>;
      const retryable = response.status >= 500 || response.status === 429 || record.retryable === true;
      throw new ServiceCallError(
        String(record.message ?? detail ?? `HTTP ${response.status}`),
        service,
        response.status,
        String(record.code ?? 'SERVICE_ERROR'),
        retryable,
        detail,
      );
    }
    return parsed as T;
  } catch (error) {
    if (error instanceof ServiceCallError) throw error;
    throw new ServiceCallError(
      `${service} request failed: ${(error as Error).message}`,
      service,
      0,
      (error as Error).name === 'AbortError' ? 'TIMEOUT' : 'NETWORK_ERROR',
      true,
    );
  } finally {
    clearTimeout(timer);
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 1000) };
  }
}

export interface ProbeResponse {
  duration_seconds: number;
  width: number;
  height: number;
  frame_rate: number;
  video_codec: string | null;
  audio_codec: string | null;
  audio_channels: number | null;
  audio_sample_rate: number | null;
  container: string;
  bit_rate: number | null;
  rotation: number;
}

export interface AnalyzeResponse {
  job_id: string;
  probe: ProbeResponse;
  transcript: {
    language: string;
    language_probability: number;
    duration_seconds: number;
    provider: string;
    model: string;
    word_timestamps: boolean;
    full_text: string;
    segments: Array<{
      sequence: number;
      start: number;
      end: number;
      text: string;
      words: Array<{ word: string; start: number; end: number; probability: number }>;
      avg_logprob: number | null;
      no_speech_prob: number | null;
    }>;
  };
  observations: Array<{ timestamp: number; description: string; faces_present: number; shot_type: string }>;
  plan: Array<{
    candidate: Record<string, unknown> & { start_time: number; end_time: number; target_duration: number; transcript: string };
    duration_kind: number;
    start_time: number;
    end_time: number;
    derived: boolean;
    derivation_note?: string;
    visual_context?: string;
  }>;
  rejected_candidates: unknown[];
  duplicates_dropped: unknown[];
  variant_decisions: Array<{ candidate_start: number; decision: string; detail: string }>;
  report: Record<string, unknown> & { outcome?: string; explanation?: string; provider: string; clips_planned: number };
  artifacts?: Record<string, string>;
}

export interface RenderResponse {
  outputPath: string;
  durationSeconds: number;
  width: number;
  height: number;
  fps: number;
  sizeBytes: number;
  videoCodec: string;
  audioCodec: string;
  bitrateKbps: number;
  framing: { mode: string; trackedFrames: number; totalFrames: number; coverage: number; fallbackUsed: boolean; note: string };
  subtitleWordCount: number;
  subtitleStats: Record<string, unknown>;
  audio: Record<string, unknown>;
  validationErrors: string[];
}

export const aiEngine = {
  probeTimeoutMs: 120_000,
  analyze(body: unknown, timeoutMs = 30 * 60_000) {
    return post<AnalyzeResponse>('ai-engine', env.AI_ENGINE_URL, env.AI_ENGINE_API_KEY, '/analyze', body, timeoutMs);
  },
  transcribe(body: unknown, timeoutMs = 20 * 60_000) {
    return post<{ provider: string; transcription: AnalyzeResponse['transcript'] }>(
      'ai-engine',
      env.AI_ENGINE_URL,
      env.AI_ENGINE_API_KEY,
      '/transcribe',
      body,
      timeoutMs,
    );
  },
  captions(body: unknown, timeoutMs = 10 * 60_000) {
    return post<{ provider: string; model: string; results: Array<{ clipId: string; ok: boolean; metadata?: Record<string, any>; error?: string }> }>(
      'ai-engine',
      env.AI_ENGINE_URL,
      env.AI_ENGINE_API_KEY,
      '/captions',
      body,
      timeoutMs,
    );
  },
};

export const videoProcessor = {
  probe(path: string) {
    return post<ProbeResponse>('video-processor', env.VIDEO_PROCESSOR_URL, env.VIDEO_PROCESSOR_API_KEY, '/probe', { path }, 120_000);
  },
  render(body: unknown, timeoutMs = 60 * 60_000) {
    return post<RenderResponse>('video-processor', env.VIDEO_PROCESSOR_URL, env.VIDEO_PROCESSOR_API_KEY, '/render', body, timeoutMs);
  },
  audioAnalysis(path: string, start?: number, duration?: number) {
    return post<Record<string, unknown>>(
      'video-processor',
      env.VIDEO_PROCESSOR_URL,
      env.VIDEO_PROCESSOR_API_KEY,
      '/audio-analysis',
      { path, start, duration },
      10 * 60_000,
    );
  },
};
