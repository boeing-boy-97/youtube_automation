/**
 * @clipforge/shared-types
 * Contract shared by the API, workers and the web app. Kept dependency-free.
 */

// ------------------------------- job states -------------------------------

export const JOB_STATES = [
  'CREATED',
  'UPLOADING',
  'QUEUED',
  'PROBING',
  'TRANSCRIBING',
  'AI_ANALYSIS',
  'CLIP_SELECTION',
  'RENDERING',
  'VALIDATION',
  'ASSET_STORAGE',
  'PUBLISHING_QUEUED',
  'PUBLISHING',
  'COMPLETED',
  'PARTIALLY_COMPLETED',
  'FAILED',
  'CANCELLED',
  'NEEDS_CONFIGURATION',
  'RETRYING',
] as const;
export type JobState = (typeof JOB_STATES)[number];

/** Linear happy-path pipeline. Terminal and control states are handled separately. */
export const PIPELINE_STATES: JobState[] = [
  'CREATED',
  'UPLOADING',
  'QUEUED',
  'PROBING',
  'TRANSCRIBING',
  'AI_ANALYSIS',
  'CLIP_SELECTION',
  'RENDERING',
  'VALIDATION',
  'ASSET_STORAGE',
  'PUBLISHING_QUEUED',
  'PUBLISHING',
  'COMPLETED',
];

export const TERMINAL_STATES: JobState[] = [
  'COMPLETED',
  'PARTIALLY_COMPLETED',
  'FAILED',
  'CANCELLED',
  'NEEDS_CONFIGURATION',
];

/**
 * Allowed transitions of the durable job state machine.
 * RETRYING may be entered from any non-terminal state whose stage failed and
 * must return to the stage recorded on the last successful JobStage row.
 */
export const JOB_TRANSITIONS: Record<JobState, JobState[]> = {
  CREATED: ['UPLOADING', 'QUEUED', 'CANCELLED', 'NEEDS_CONFIGURATION', 'FAILED'],
  UPLOADING: ['QUEUED', 'FAILED', 'CANCELLED', 'RETRYING'],
  QUEUED: ['PROBING', 'CANCELLED', 'FAILED', 'NEEDS_CONFIGURATION', 'RETRYING'],
  PROBING: ['TRANSCRIBING', 'FAILED', 'CANCELLED', 'RETRYING'],
  TRANSCRIBING: ['AI_ANALYSIS', 'FAILED', 'CANCELLED', 'RETRYING'],
  AI_ANALYSIS: ['CLIP_SELECTION', 'FAILED', 'CANCELLED', 'RETRYING'],
  CLIP_SELECTION: ['RENDERING', 'COMPLETED', 'FAILED', 'CANCELLED', 'RETRYING'],
  RENDERING: ['VALIDATION', 'FAILED', 'CANCELLED', 'RETRYING'],
  VALIDATION: ['ASSET_STORAGE', 'FAILED', 'CANCELLED', 'RETRYING'],
  ASSET_STORAGE: ['PUBLISHING_QUEUED', 'COMPLETED', 'PARTIALLY_COMPLETED', 'FAILED', 'CANCELLED', 'RETRYING'],
  PUBLISHING_QUEUED: ['PUBLISHING', 'COMPLETED', 'CANCELLED', 'FAILED', 'RETRYING'],
  PUBLISHING: ['COMPLETED', 'PARTIALLY_COMPLETED', 'FAILED', 'RETRYING'],
  COMPLETED: [],
  PARTIALLY_COMPLETED: ['RETRYING'],
  FAILED: ['RETRYING'],
  CANCELLED: [],
  NEEDS_CONFIGURATION: ['RETRYING', 'CANCELLED'],
  RETRYING: PIPELINE_STATES.filter((s) => s !== 'CREATED' && s !== 'COMPLETED'),
};

export function canTransition(from: JobState, to: JobState): boolean {
  return (JOB_TRANSITIONS[from] ?? []).includes(to);
}

export function isTerminal(state: JobState): boolean {
  return TERMINAL_STATES.includes(state);
}

// ------------------------------- error model ------------------------------

export const ERROR_CODES = {
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  CSRF_FAILED: 'CSRF_FAILED',
  CONFIGURATION_REQUIRED: 'CONFIGURATION_REQUIRED',
  UNSUPPORTED_MEDIA: 'UNSUPPORTED_MEDIA',
  MEDIA_VALIDATION_FAILED: 'MEDIA_VALIDATION_FAILED',
  RIGHTS_NOT_DECLARED: 'RIGHTS_NOT_DECLARED',
  SSRF_BLOCKED: 'SSRF_BLOCKED',
  STORAGE_UNAVAILABLE: 'STORAGE_UNAVAILABLE',
  AI_PROVIDER_ERROR: 'AI_PROVIDER_ERROR',
  AI_SCHEMA_INVALID: 'AI_SCHEMA_INVALID',
  TRANSCRIPTION_FAILED: 'TRANSCRIPTION_FAILED',
  RENDER_FAILED: 'RENDER_FAILED',
  NO_CANDIDATES: 'NO_CANDIDATES',
  PUBLISH_ELIGIBILITY_FAILED: 'PUBLISH_ELIGIBILITY_FAILED',
  PUBLISH_FAILED: 'PUBLISH_FAILED',
  PUBLISH_PERMANENT_FAILURE: 'PUBLISH_PERMANENT_FAILURE',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  PLATFORM_RATE_LIMITED: 'PLATFORM_RATE_LIMITED',
  DUPLICATE_SUPPRESSED: 'DUPLICATE_SUPPRESSED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;
export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export interface ApiErrorBody {
  error: {
    code: ErrorCode | string;
    message: string;
    details?: unknown;
    missingConfiguration?: string[];
    requestId?: string;
  };
}

// ------------------------------ domain types ------------------------------

export type Platform = 'YOUTUBE' | 'INSTAGRAM';
export type ClipDurationKind = 15 | 30;

export interface CandidateScores {
  hookQuality: number;
  standaloneMeaning: number;
  completeness: number;
  informationalValue: number;
  emotionalEngagement: number;
  storytelling: number;
  audioClarity: number;
  visualSuitability: number;
  viewerInterest: number;
  contextPreservation: number;
}

export interface HighlightCandidate {
  start_time: number;
  end_time: number;
  target_duration: ClipDurationKind;
  hook: string;
  reason: string;
  transcript: string;
  content_category: string;
  quality_score: number;
  confidence: number;
  visual_context: string;
  scores: CandidateScores;
}

export interface TranscriptionWord {
  word: string;
  start: number;
  end: number;
  probability: number;
}

export interface TranscriptionSegment {
  sequence: number;
  start: number;
  end: number;
  text: string;
  words: TranscriptionWord[];
  speaker_label?: string | null;
  avg_logprob?: number | null;
  no_speech_prob?: number | null;
}

export interface TranscriptionResult {
  language: string;
  language_probability: number;
  duration_seconds: number;
  provider: string;
  model: string;
  word_timestamps: boolean;
  full_text: string;
  segments: TranscriptionSegment[];
}

export interface ProbeResult {
  duration_seconds: number;
  width: number;
  height: number;
  frame_rate: number;
  video_codec: string;
  audio_codec: string | null;
  audio_channels: number | null;
  audio_sample_rate: number | null;
  container: string;
  bit_rate: number | null;
  rotation: number;
  raw: unknown;
}

export interface AudioAnalysisResult {
  integrated_loudness_lufs: number | null;
  true_peak_dbtp: number | null;
  silence_ranges: Array<{ start: number; end: number }>;
  clipping_detected: boolean;
  mean_volume_db: number | null;
  notes: string[];
}

export interface RenderProfile {
  width: number;
  height: number;
  fps: number;
  videoCodec: 'h264' | 'hevc';
  audioCodec: 'aac';
  bitrateKbps: number;
  framingMode: 'face_track' | 'center_crop' | 'manual' | 'background_blur';
  manualOffsetX?: number;
  manualOffsetY?: number;
  subtitlePreset: SubtitleStyle;
  loudnessTargetLufs: number;
  watermarkPosition?: string | null;
  logoStorageKey?: string | null;
  backgroundMusicKey?: string | null;
}

export interface SubtitleStyle {
  fontFamily: string;
  fontSizePx: number;
  fontWeight: number;
  primaryColor: string;
  highlightColor: string;
  outlineColor: string;
  outlineWidth: number;
  shadow: number;
  position: 'lower-third' | 'middle' | 'upper-third';
  safeMarginXPx: number;
  safeMarginBottomPx: number;
  backgroundOpacity: number;
  uppercase: boolean;
  maxCharsPerLine: number;
  maxLines: number;
}

export interface RenderReport {
  outputPath: string;
  durationSeconds: number;
  width: number;
  height: number;
  fps: number;
  sizeBytes: number;
  videoCodec: string;
  audioCodec: string;
  framing: { mode: string; trackedFrames?: number; fallbackUsed: boolean; note?: string };
  subtitleWordCount: number;
  audio: AudioAnalysisResult;
  validationErrors: string[];
}

// --------------------------- configuration keys ---------------------------
/**
 * Canonical configuration registry. Values live in ApplicationConfiguration
 * (workspace-scoped override wins over global). There are NO defaults in code:
 * a missing key makes dependent processing fail with CONFIGURATION_REQUIRED.
 */
export const CONFIG_KEYS = {
  AI_TEXT_MODEL: 'ai.text_model',
  AI_VISION_MODEL: 'ai.vision_model',
  AI_MAX_OUTPUT_CLIPS: 'ai.max_output_clips',
  AI_MIN_QUALITY_SCORE: 'ai.min_quality_score',
  AI_MAX_CANDIDATES_PER_CALL: 'ai.max_candidates_per_call',
  PROCESSING_MAX_DURATION_SECONDS: 'processing.max_duration_seconds',
  PROCESSING_MAX_FILE_SIZE_BYTES: 'processing.max_file_size_bytes',
  PROCESSING_MAX_CONCURRENT_JOBS: 'processing.max_concurrent_jobs',
  RENDER_OUTPUT_WIDTH: 'render.output_width',
  RENDER_OUTPUT_HEIGHT: 'render.output_height',
  RENDER_FPS: 'render.fps',
  RENDER_BITRATE_KBPS: 'render.bitrate_kbps',
  RENDER_FRAMING_MODE: 'render.framing_mode',
  RENDER_FRAMING_FALLBACK: 'render.framing_fallback',
  SUBTITLE_PRESET_ID: 'subtitles.preset_id',
  SUBTITLE_LANGUAGE: 'subtitles.language',
  PUBLISHING_YOUTUBE_VISIBILITY: 'publishing.youtube_visibility',
  PUBLISHING_AUTO_ENABLED: 'publishing.auto_enabled',
  STORAGE_PROVIDER: 'storage.provider',
  RETENTION_SOURCE_DAYS: 'retention.source_days',
  RETENTION_ASSET_DAYS: 'retention.asset_days',
  TIMEZONE: 'workspace.timezone',
  DUPLICATE_SIMILARITY_THRESHOLD: 'clips.duplicate_similarity_threshold',
  AUDIO_LOUDNESS_TARGET_LUFS: 'audio.loudness_target_lufs',
  CONTENT_LANGUAGES: 'content.languages',
} as const;
export type ConfigKey = (typeof CONFIG_KEYS)[keyof typeof CONFIG_KEYS];

export const REQUIRED_FOR_PROCESSING: ConfigKey[] = [
  CONFIG_KEYS.AI_TEXT_MODEL,
  CONFIG_KEYS.AI_VISION_MODEL,
  CONFIG_KEYS.AI_MAX_OUTPUT_CLIPS,
  CONFIG_KEYS.AI_MIN_QUALITY_SCORE,
  CONFIG_KEYS.PROCESSING_MAX_DURATION_SECONDS,
  CONFIG_KEYS.PROCESSING_MAX_FILE_SIZE_BYTES,
  CONFIG_KEYS.RENDER_OUTPUT_WIDTH,
  CONFIG_KEYS.RENDER_OUTPUT_HEIGHT,
  CONFIG_KEYS.RENDER_FPS,
  CONFIG_KEYS.RENDER_BITRATE_KBPS,
  CONFIG_KEYS.RENDER_FRAMING_MODE,
  CONFIG_KEYS.SUBTITLE_PRESET_ID,
  CONFIG_KEYS.SUBTITLE_LANGUAGE,
  CONFIG_KEYS.STORAGE_PROVIDER,
  CONFIG_KEYS.TIMEZONE,
  CONFIG_KEYS.DUPLICATE_SIMILARITY_THRESHOLD,
  CONFIG_KEYS.AUDIO_LOUDNESS_TARGET_LUFS,
];

export const REQUIRED_FOR_PUBLISHING: ConfigKey[] = [
  CONFIG_KEYS.PUBLISHING_AUTO_ENABLED,
  CONFIG_KEYS.PUBLISHING_YOUTUBE_VISIBILITY,
];

// ------------------------------- API shapes -------------------------------

export interface Paginated<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

export interface SessionInfo {
  user: { id: string; email: string; displayName: string; role: string };
  workspace: { id: string; name: string; slug: string; timezone: string | null };
  csrfToken: string;
  configuration: { processingReady: boolean; publishingReady: boolean; missing: string[] };
}

export interface JobEventDto {
  id: string;
  stage: JobState;
  status: 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'SKIPPED' | 'CANCELLED';
  progressPercent: number;
  errorCode?: string | null;
  errorMessage?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  durationMs?: number | null;
}

export interface JobDetailDto {
  id: string;
  status: JobState;
  stage: JobState;
  progressPercent: number;
  progressDetail?: string | null;
  attempt: number;
  workerId?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  createdAt: string;
  startedAt?: string | null;
  completedAt?: string | null;
  estimatedCompletionAt?: string | null;
  source: { id: string; originalFileName?: string | null; durationSeconds?: number | null };
  events: JobEventDto[];
  clipCount: number;
  resultSummary?: unknown;
}
