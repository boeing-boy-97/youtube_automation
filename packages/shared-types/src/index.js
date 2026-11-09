"use strict";
/**
 * @clipforge/shared-types
 * Contract shared by the API, workers and the web app. Kept dependency-free.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.REQUIRED_FOR_PUBLISHING = exports.REQUIRED_FOR_PROCESSING = exports.CONFIG_KEYS = exports.ERROR_CODES = exports.JOB_TRANSITIONS = exports.TERMINAL_STATES = exports.PIPELINE_STATES = exports.JOB_STATES = void 0;
exports.canTransition = canTransition;
exports.isTerminal = isTerminal;
// ------------------------------- job states -------------------------------
exports.JOB_STATES = [
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
];
/** Linear happy-path pipeline. Terminal and control states are handled separately. */
exports.PIPELINE_STATES = [
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
exports.TERMINAL_STATES = [
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
exports.JOB_TRANSITIONS = {
    CREATED: ['UPLOADING', 'QUEUED', 'CANCELLED', 'NEEDS_CONFIGURATION', 'FAILED'],
    UPLOADING: ['QUEUED', 'FAILED', 'CANCELLED', 'RETRYING'],
    QUEUED: ['PROBING', 'CANCELLED', 'FAILED', 'NEEDS_CONFIGURATION', 'RETRYING'],
    PROBING: ['TRANSCRIBING', 'FAILED', 'CANCELLED', 'RETRYING'],
    TRANSCRIBING: ['AI_ANALYSIS', 'FAILED', 'CANCELLED', 'RETRYING'],
    AI_ANALYSIS: ['CLIP_SELECTION', 'FAILED', 'CANCELLED', 'RETRYING'],
    CLIP_SELECTION: ['RENDERING', 'COMPLETED', 'FAILED', 'CANCELLED', 'RETRYING'],
    RENDERING: ['VALIDATION', 'FAILED', 'CANCELLED', 'RETRYING'],
    VALIDATION: ['ASSET_STORAGE', 'FAILED', 'CANCELLED', 'RETRYING'],
    ASSET_STORAGE: ['PUBLISHING_QUEUED', 'PARTIALLY_COMPLETED', 'FAILED', 'CANCELLED', 'RETRYING'],
    PUBLISHING_QUEUED: ['PUBLISHING', 'COMPLETED', 'CANCELLED', 'FAILED', 'RETRYING'],
    PUBLISHING: ['COMPLETED', 'PARTIALLY_COMPLETED', 'FAILED', 'RETRYING'],
    COMPLETED: [],
    PARTIALLY_COMPLETED: ['RETRYING'],
    FAILED: ['RETRYING'],
    CANCELLED: [],
    NEEDS_CONFIGURATION: ['RETRYING', 'CANCELLED'],
    RETRYING: exports.PIPELINE_STATES.filter((s) => s !== 'CREATED' && s !== 'COMPLETED'),
};
function canTransition(from, to) {
    return (exports.JOB_TRANSITIONS[from] ?? []).includes(to);
}
function isTerminal(state) {
    return exports.TERMINAL_STATES.includes(state);
}
// ------------------------------- error model ------------------------------
exports.ERROR_CODES = {
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
};
// --------------------------- configuration keys ---------------------------
/**
 * Canonical configuration registry. Values live in ApplicationConfiguration
 * (workspace-scoped override wins over global). There are NO defaults in code:
 * a missing key makes dependent processing fail with CONFIGURATION_REQUIRED.
 */
exports.CONFIG_KEYS = {
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
};
exports.REQUIRED_FOR_PROCESSING = [
    exports.CONFIG_KEYS.AI_TEXT_MODEL,
    exports.CONFIG_KEYS.AI_VISION_MODEL,
    exports.CONFIG_KEYS.AI_MAX_OUTPUT_CLIPS,
    exports.CONFIG_KEYS.AI_MIN_QUALITY_SCORE,
    exports.CONFIG_KEYS.PROCESSING_MAX_DURATION_SECONDS,
    exports.CONFIG_KEYS.PROCESSING_MAX_FILE_SIZE_BYTES,
    exports.CONFIG_KEYS.RENDER_OUTPUT_WIDTH,
    exports.CONFIG_KEYS.RENDER_OUTPUT_HEIGHT,
    exports.CONFIG_KEYS.RENDER_FPS,
    exports.CONFIG_KEYS.RENDER_BITRATE_KBPS,
    exports.CONFIG_KEYS.RENDER_FRAMING_MODE,
    exports.CONFIG_KEYS.SUBTITLE_PRESET_ID,
    exports.CONFIG_KEYS.SUBTITLE_LANGUAGE,
    exports.CONFIG_KEYS.STORAGE_PROVIDER,
    exports.CONFIG_KEYS.TIMEZONE,
    exports.CONFIG_KEYS.DUPLICATE_SIMILARITY_THRESHOLD,
    exports.CONFIG_KEYS.AUDIO_LOUDNESS_TARGET_LUFS,
];
exports.REQUIRED_FOR_PUBLISHING = [
    exports.CONFIG_KEYS.PUBLISHING_AUTO_ENABLED,
    exports.CONFIG_KEYS.PUBLISHING_YOUTUBE_VISIBILITY,
];
//# sourceMappingURL=index.js.map