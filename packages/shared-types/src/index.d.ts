/**
 * @clipforge/shared-types
 * Contract shared by the API, workers and the web app. Kept dependency-free.
 */
export declare const JOB_STATES: readonly ["CREATED", "UPLOADING", "QUEUED", "PROBING", "TRANSCRIBING", "AI_ANALYSIS", "CLIP_SELECTION", "RENDERING", "VALIDATION", "ASSET_STORAGE", "PUBLISHING_QUEUED", "PUBLISHING", "COMPLETED", "PARTIALLY_COMPLETED", "FAILED", "CANCELLED", "NEEDS_CONFIGURATION", "RETRYING"];
export type JobState = (typeof JOB_STATES)[number];
/** Linear happy-path pipeline. Terminal and control states are handled separately. */
export declare const PIPELINE_STATES: JobState[];
export declare const TERMINAL_STATES: JobState[];
/**
 * Allowed transitions of the durable job state machine.
 * RETRYING may be entered from any non-terminal state whose stage failed and
 * must return to the stage recorded on the last successful JobStage row.
 */
export declare const JOB_TRANSITIONS: Record<JobState, JobState[]>;
export declare function canTransition(from: JobState, to: JobState): boolean;
export declare function isTerminal(state: JobState): boolean;
export declare const ERROR_CODES: {
    readonly VALIDATION_FAILED: "VALIDATION_FAILED";
    readonly UNAUTHENTICATED: "UNAUTHENTICATED";
    readonly FORBIDDEN: "FORBIDDEN";
    readonly NOT_FOUND: "NOT_FOUND";
    readonly CONFLICT: "CONFLICT";
    readonly RATE_LIMITED: "RATE_LIMITED";
    readonly CSRF_FAILED: "CSRF_FAILED";
    readonly CONFIGURATION_REQUIRED: "CONFIGURATION_REQUIRED";
    readonly UNSUPPORTED_MEDIA: "UNSUPPORTED_MEDIA";
    readonly MEDIA_VALIDATION_FAILED: "MEDIA_VALIDATION_FAILED";
    readonly RIGHTS_NOT_DECLARED: "RIGHTS_NOT_DECLARED";
    readonly SSRF_BLOCKED: "SSRF_BLOCKED";
    readonly STORAGE_UNAVAILABLE: "STORAGE_UNAVAILABLE";
    readonly AI_PROVIDER_ERROR: "AI_PROVIDER_ERROR";
    readonly AI_SCHEMA_INVALID: "AI_SCHEMA_INVALID";
    readonly TRANSCRIPTION_FAILED: "TRANSCRIPTION_FAILED";
    readonly RENDER_FAILED: "RENDER_FAILED";
    readonly NO_CANDIDATES: "NO_CANDIDATES";
    readonly PUBLISH_ELIGIBILITY_FAILED: "PUBLISH_ELIGIBILITY_FAILED";
    readonly PUBLISH_FAILED: "PUBLISH_FAILED";
    readonly PUBLISH_PERMANENT_FAILURE: "PUBLISH_PERMANENT_FAILURE";
    readonly TOKEN_EXPIRED: "TOKEN_EXPIRED";
    readonly PLATFORM_RATE_LIMITED: "PLATFORM_RATE_LIMITED";
    readonly DUPLICATE_SUPPRESSED: "DUPLICATE_SUPPRESSED";
    readonly INTERNAL_ERROR: "INTERNAL_ERROR";
};
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
    silence_ranges: Array<{
        start: number;
        end: number;
    }>;
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
    framing: {
        mode: string;
        trackedFrames?: number;
        fallbackUsed: boolean;
        note?: string;
    };
    subtitleWordCount: number;
    audio: AudioAnalysisResult;
    validationErrors: string[];
}
/**
 * Canonical configuration registry. Values live in ApplicationConfiguration
 * (workspace-scoped override wins over global). There are NO defaults in code:
 * a missing key makes dependent processing fail with CONFIGURATION_REQUIRED.
 */
export declare const CONFIG_KEYS: {
    readonly AI_TEXT_MODEL: "ai.text_model";
    readonly AI_VISION_MODEL: "ai.vision_model";
    readonly AI_MAX_OUTPUT_CLIPS: "ai.max_output_clips";
    readonly AI_MIN_QUALITY_SCORE: "ai.min_quality_score";
    readonly AI_MAX_CANDIDATES_PER_CALL: "ai.max_candidates_per_call";
    readonly PROCESSING_MAX_DURATION_SECONDS: "processing.max_duration_seconds";
    readonly PROCESSING_MAX_FILE_SIZE_BYTES: "processing.max_file_size_bytes";
    readonly PROCESSING_MAX_CONCURRENT_JOBS: "processing.max_concurrent_jobs";
    readonly RENDER_OUTPUT_WIDTH: "render.output_width";
    readonly RENDER_OUTPUT_HEIGHT: "render.output_height";
    readonly RENDER_FPS: "render.fps";
    readonly RENDER_BITRATE_KBPS: "render.bitrate_kbps";
    readonly RENDER_FRAMING_MODE: "render.framing_mode";
    readonly RENDER_FRAMING_FALLBACK: "render.framing_fallback";
    readonly SUBTITLE_PRESET_ID: "subtitles.preset_id";
    readonly SUBTITLE_LANGUAGE: "subtitles.language";
    readonly PUBLISHING_YOUTUBE_VISIBILITY: "publishing.youtube_visibility";
    readonly PUBLISHING_AUTO_ENABLED: "publishing.auto_enabled";
    readonly STORAGE_PROVIDER: "storage.provider";
    readonly RETENTION_SOURCE_DAYS: "retention.source_days";
    readonly RETENTION_ASSET_DAYS: "retention.asset_days";
    readonly TIMEZONE: "workspace.timezone";
    readonly DUPLICATE_SIMILARITY_THRESHOLD: "clips.duplicate_similarity_threshold";
    readonly AUDIO_LOUDNESS_TARGET_LUFS: "audio.loudness_target_lufs";
    readonly CONTENT_LANGUAGES: "content.languages";
};
export type ConfigKey = (typeof CONFIG_KEYS)[keyof typeof CONFIG_KEYS];
export declare const REQUIRED_FOR_PROCESSING: ConfigKey[];
export declare const REQUIRED_FOR_PUBLISHING: ConfigKey[];
export interface Paginated<T> {
    items: T[];
    page: number;
    pageSize: number;
    total: number;
}
export interface SessionInfo {
    user: {
        id: string;
        email: string;
        displayName: string;
        role: string;
    };
    workspace: {
        id: string;
        name: string;
        slug: string;
        timezone: string | null;
    };
    csrfToken: string;
    configuration: {
        processingReady: boolean;
        publishingReady: boolean;
        missing: string[];
    };
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
    source: {
        id: string;
        originalFileName?: string | null;
        durationSeconds?: number | null;
    };
    events: JobEventDto[];
    clipCount: number;
    resultSummary?: unknown;
}
