export type FieldKind = 'number' | 'integer' | 'boolean' | 'text' | 'select' | 'list' | 'preset';

export interface ConfigField {
  key: string;
  label: string;
  kind: FieldKind;
  group: string;
  hint: string;
  options?: Array<{ value: string | number | boolean; label: string }>;
  min?: number;
  max?: number;
  unit?: string;
}

/**
 * Field metadata only — no values. Defaults are deliberately absent: every value
 * must be set explicitly by an operator, matching the API's ConfigurationService.
 */
export const CONFIG_FIELDS: ConfigField[] = [
  { key: 'ai.text_model', label: 'AI text model', kind: 'text', group: 'AI analysis', hint: 'Gemini model id used for structured highlight analysis, e.g. gemini-2.5-flash.' },
  { key: 'ai.vision_model', label: 'AI vision model', kind: 'text', group: 'AI analysis', hint: 'Gemini model id used for frame-sampling visual analysis.' },
  { key: 'ai.max_output_clips', label: 'Maximum clips per video', kind: 'integer', group: 'AI analysis', hint: 'Upper bound only — the model decides how many clips actually qualify.', min: 1, max: 50 },
  { key: 'ai.min_quality_score', label: 'Minimum quality score', kind: 'integer', group: 'AI analysis', hint: 'Clips scoring below this are discarded. Higher values mean fewer, stronger clips.', min: 0, max: 100 },
  { key: 'ai.max_candidates_per_call', label: 'Max candidates per AI call', kind: 'integer', group: 'AI analysis', hint: 'Bounds a single structured-generation response so outputs stay parseable.', min: 1, max: 50 },
  { key: 'clips.duplicate_similarity_threshold', label: 'Duplicate similarity threshold', kind: 'number', group: 'AI analysis', hint: '0–1. Overlapping candidates above this transcript similarity are suppressed.', min: 0, max: 1 },
  { key: 'content.languages', label: 'Content languages', kind: 'list', group: 'AI analysis', hint: 'Comma-separated ISO codes, e.g. en,hi. Used to validate transcript language.' },
  { key: 'render.output_width', label: 'Output width', kind: 'integer', group: 'Rendering', hint: 'Pixels. Vertical 9:16 output is validated at render time.', min: 360, max: 4320 },
  { key: 'render.output_height', label: 'Output height', kind: 'integer', group: 'Rendering', hint: 'Pixels. Required height = width × 16 / 9.', min: 640, max: 7680 },
  { key: 'render.fps', label: 'Frame rate', kind: 'integer', group: 'Rendering', hint: 'Output frames per second.', min: 24, max: 60 },
  { key: 'render.bitrate_kbps', label: 'Video bitrate (kbps)', kind: 'integer', group: 'Rendering', hint: 'H.264 target bitrate.', min: 1000, max: 20000 },
  { key: 'render.framing_mode', label: 'Framing mode', kind: 'select', group: 'Rendering', hint: 'How the 9:16 frame is derived from the source.', options: [
    { value: 'center_crop', label: 'Centre crop' },
    { value: 'face_tracking', label: 'Face tracking (falls back to the configured fallback)' },
    { value: 'fit_with_blur', label: 'Fit with blurred background' },
  ] },
  { key: 'render.framing_fallback', label: 'Framing fallback', kind: 'select', group: 'Rendering', hint: 'Used only when face tracking finds no face. Never applied silently.', options: [
    { value: 'center_crop', label: 'Centre crop' },
    { value: 'fit_with_blur', label: 'Fit with blurred background' },
  ] },
  { key: 'subtitles.preset_id', label: 'Subtitle preset', kind: 'preset', group: 'Subtitles', hint: 'Create a preset in Brand studio first — there is no implicit style.' },
  { key: 'subtitles.language', label: 'Subtitle language', kind: 'text', group: 'Subtitles', hint: 'ISO-639-1 code for the burned-in captions.' },
  { key: 'audio.loudness_target_lufs', label: 'Loudness target (LUFS)', kind: 'number', group: 'Audio', hint: 'Integrated loudness target applied by the loudnorm filter.', min: -30, max: -5 },
  { key: 'storage.provider', label: 'Storage provider', kind: 'select', group: 'Storage & retention', hint: 'Where renders are stored. Must match the API STORAGE_DRIVER.', options: [
    { value: 'local', label: 'Local filesystem (development)' },
    { value: 's3', label: 'S3-compatible object storage (AWS S3 / Cloudflare R2)' },
  ] },
  { key: 'retention.source_days', label: 'Source retention (days)', kind: 'integer', group: 'Storage & retention', hint: 'Days an original upload is kept before the retention sweeper removes it.', min: 1, max: 3650 },
  { key: 'retention.asset_days', label: 'Rendered asset retention (days)', kind: 'integer', group: 'Storage & retention', hint: 'Must outlive the Meta fetch window for unpublished Reels.', min: 1, max: 3650 },
  { key: 'processing.max_duration_seconds', label: 'Maximum source duration (s)', kind: 'integer', group: 'Limits', hint: 'Uploads longer than this are rejected at validation.', min: 10, max: 21600 },
  { key: 'processing.max_file_size_bytes', label: 'Maximum file size (bytes)', kind: 'integer', group: 'Limits', hint: 'Enforced at upload initiation and re-checked server-side.', min: 1048576 },
  { key: 'processing.max_concurrent_jobs', label: 'Max concurrent jobs', kind: 'integer', group: 'Limits', hint: 'Pipeline worker concurrency. Rendering is CPU-bound — keep it low.', min: 1, max: 8 },
  { key: 'workspace.timezone', label: 'Timezone', kind: 'text', group: 'Publishing', hint: 'IANA name, e.g. Asia/Kolkata. Used for schedules and logs.' },
  { key: 'publishing.youtube_visibility', label: 'YouTube visibility', kind: 'select', group: 'Publishing', hint: 'Privacy applied to uploads unless a per-account override exists.', options: [
    { value: 'PRIVATE', label: 'Private' },
    { value: 'UNLISTED', label: 'Unlisted' },
    { value: 'PUBLIC', label: 'Public' },
  ] },
  { key: 'publishing.auto_enabled', label: 'Automatic publishing', kind: 'boolean', group: 'Publishing', hint: 'Master switch. Publishing jobs still require an enabled account.' },
];

export const CONFIG_GROUPS = Array.from(new Set(CONFIG_FIELDS.map((field) => field.group)));
