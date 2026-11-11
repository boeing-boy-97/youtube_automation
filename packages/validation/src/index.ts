import { z } from 'zod';
import { NOTIFICATION_CATEGORIES } from '@clipforge/shared-types';

// ------------------------------- primitives -------------------------------

export const emailSchema = z.string().trim().toLowerCase().email().max(254);
/**
 * The single password policy. Every path that writes a password hash must use this schema —
 * registration, bootstrap, reset-by-code and recovery-code redemption. It previously lived in two
 * places and the recovery paths had drifted to "10 characters, no complexity", which let an account
 * end up weaker than the policy it was created under.
 */
export const passwordSchema = z
  .string()
  .min(12, 'Password must be at least 12 characters')
  .max(200)
  .refine((v) => /[a-z]/.test(v), 'Must contain a lowercase letter')
  .refine((v) => /[A-Z]/.test(v), 'Must contain an uppercase letter')
  .refine((v) => /[0-9]/.test(v), 'Must contain a digit');

export const uuidSchema = z.string().uuid();
export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

// --------------------------------- auth -----------------------------------

export const bootstrapSchema = z.object({
  bootstrapToken: z.string().min(32),
  email: emailSchema,
  password: passwordSchema,
  displayName: z.string().trim().min(2).max(120),
  workspaceName: z.string().trim().min(2).max(120),
});

export const registerSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  displayName: z.string().trim().min(2).max(120),
  workspaceName: z.string().trim().min(2).max(120).optional(),
});

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(200),
});

export const firebaseLoginSchema = z.object({
  // A Firebase ID token is a JWT; the server verifies signature, audience and expiry. The length
  // bound is only there to reject obvious garbage before it reaches the verifier.
  idToken: z.string().min(64).max(8192),
});

// -------------------------------- sources ---------------------------------

export const SUPPORTED_VIDEO_MIME = [
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'video/x-matroska',
] as const;

export const SUPPORTED_VIDEO_EXTENSIONS = ['.mp4', '.mov', '.webm', '.mkv', '.m4v'] as const;

export const initiateUploadSchema = z.object({
  fileName: z.string().trim().min(1).max(255),
  mimeType: z.enum(SUPPORTED_VIDEO_MIME),
  sizeBytes: z.coerce.number().int().positive(),
  youTubeReferenceUrl: z
    .string()
    .trim()
    .url()
    .refine((u) => /^https:\/\/(www\.|m\.)?(youtube\.com|youtu\.be)\//.test(u), 'Must be a YouTube URL')
    .optional(),
});

export const completeUploadSchema = z.object({
  sourceVideoId: uuidSchema,
  rightsDeclaration: z.object({
    accepted: z.literal(true),
    statement: z.string().trim().min(20).max(2000),
  }),
});

export const importUrlSchema = z.object({
  url: z.string().trim().url().max(2048),
  fileName: z.string().trim().min(1).max(255).optional(),
  youTubeReferenceUrl: z
    .string()
    .trim()
    .url()
    .refine((u) => /^https:\/\/(www\.)?(youtube\.com|youtu\.be)\//.test(u), 'Must be a YouTube URL')
    .optional(),
  rightsDeclaration: z.object({
    accepted: z.literal(true),
    statement: z.string().trim().min(20).max(2000),
  }),
});

// ------------------------------- processing -------------------------------

export const createJobSchema = z.object({
  sourceVideoId: uuidSchema,
  configuration: z.object({
    framingMode: z.enum(['face_track', 'center_crop', 'manual', 'background_blur']),
    framingFallback: z.enum(['center_crop', 'background_blur', 'fail']),
    subtitlePresetId: uuidSchema,
    subtitleLanguage: z.string().min(2).max(16),
    contentLanguages: z.array(z.string().min(2).max(16)).min(1).max(5),
    targetDurations: z.array(z.union([z.literal(15), z.literal(30)])).min(1),
    maxClips: z.number().int().min(1).max(50),
    minQualityScore: z.number().int().min(0).max(100),
    autoPublish: z.boolean(),
    platforms: z.array(z.enum(['YOUTUBE', 'INSTAGRAM'])).default([]),
    brandProfileId: uuidSchema.optional(),
    manualOffsetX: z.number().min(0).max(1).optional(),
    manualOffsetY: z.number().min(0).max(1).optional(),
  }),
});

export const jobListQuerySchema = paginationSchema.extend({
  status: z.string().optional(),
  sourceVideoId: uuidSchema.optional(),
});

// --------------------------------- clips ----------------------------------

export const updateClipMetadataSchema = z.object({
  platform: z.enum(['YOUTUBE', 'INSTAGRAM']),
  title: z.string().trim().max(100).optional(),
  description: z.string().trim().max(5000).optional(),
  hashtags: z.array(z.string().trim().regex(/^#?[A-Za-z0-9_]{2,50}$/)).max(30).optional(),
  tags: z.array(z.string().trim().min(1).max(50)).max(30).optional(),
});

export const clipListQuerySchema = paginationSchema.extend({
  jobId: uuidSchema.optional(),
  durationKind: z.coerce.number().int().optional(),
  status: z.string().optional(),
  platform: z.enum(['YOUTUBE', 'INSTAGRAM']).optional(),
});

// --------------------------------- usage ----------------------------------

/**
 * Usage reporting window. Defaults to the last 30 days; `from`/`to` are inclusive ISO dates so an
 * operator can reconcile a month without knowing the server's timezone.
 */
const isoDateSchema = z.string().refine((v) => !Number.isNaN(Date.parse(v)), 'Must be an ISO date or datetime');

export const usageSummaryQuerySchema = z
  .object({
    from: isoDateSchema.optional(),
    to: isoDateSchema.optional(),
    groupBy: z.enum(['day', 'job', 'kind']).default('kind'),
  })
  .refine((v) => !v.from || !v.to || new Date(v.from) <= new Date(v.to), {
    message: '`from` must be before or equal to `to`',
    path: ['from'],
  });

export const usageRecordsQuerySchema = paginationSchema.extend({
  kind: z
    .enum(['transcription_seconds', 'gemini_tokens', 'gemini_vision_tokens', 'render_seconds', 'storage_bytes', 'publish_calls'])
    .optional(),
  jobId: uuidSchema.optional(),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
});

// ------------------------------- publishing -------------------------------

export const publishingToggleSchema = z.object({
  platform: z.enum(['YOUTUBE', 'INSTAGRAM']),
  connectedAccountId: uuidSchema,
  enabled: z.boolean(),
  youtube: z
    .object({
      visibility: z.enum(['PUBLIC', 'UNLISTED', 'PRIVATE']),
      categoryId: z.string().trim().min(1).max(10),
      madeForKids: z.boolean(),
      defaultLanguage: z.string().min(2).max(16),
    })
    .optional(),
  instagram: z
    .object({
      shareToFeed: z.boolean(),
      defaultLanguage: z.string().min(2).max(16),
    })
    .optional(),
  termsAccepted: z.literal(true),
});

export const createPublishingJobSchema = z.object({
  clipId: uuidSchema,
  platforms: z.array(z.enum(['YOUTUBE', 'INSTAGRAM'])).min(1),
  scheduledFor: z.string().datetime().optional(),
});

// ------------------------------ configuration -----------------------------

export const configurationWriteSchema = z.object({
  entries: z
    .array(
      z.object({
        key: z.string().trim().min(3).max(120),
        value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.record(z.unknown())]),
      }),
    )
    .min(1)
    .max(100),
});

export const brandProfileSchema = z.object({
  name: z.string().trim().min(1).max(120),
  isDefault: z.boolean().optional(),
  primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  secondaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  textColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  fontFamily: z.string().trim().max(120).optional(),
  brandVoice: z.enum(['professional', 'educational', 'motivational', 'conversational', 'entertaining', 'custom']),
  customVoiceInstructions: z.string().trim().max(2000).optional(),
  audienceDescription: z.string().trim().max(1000).optional(),
  watermarkPosition: z.enum(['top-left', 'top-right', 'bottom-left', 'bottom-right']).optional(),
  logoStorageKey: z.string().max(512).nullable().optional(),
  // Branding segments are opt-in and require an explicit asset key; enabling one without an asset
  // is a validation error rather than a silent no-op.
  introEnabled: z.boolean().optional(),
  outroEnabled: z.boolean().optional(),
  introAssetKey: z.string().max(512).nullable().optional(),
  outroAssetKey: z.string().max(512).nullable().optional(),
}).superRefine((value, ctx) => {
  if (value.introEnabled && !value.introAssetKey) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['introAssetKey'], message: 'introEnabled requires introAssetKey' });
  }
  if (value.outroEnabled && !value.outroAssetKey) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['outroAssetKey'], message: 'outroEnabled requires outroAssetKey' });
  }
  if (value.brandVoice === 'custom' && !value.customVoiceInstructions) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['customVoiceInstructions'], message: 'brandVoice "custom" requires customVoiceInstructions' });
  }
});

export const subtitlePresetSchema = z.object({
  name: z.string().trim().min(1).max(80),
  style: z.object({
    fontFamily: z.string().min(1).max(120),
    fontSizePx: z.number().int().min(16).max(160),
    fontWeight: z.number().int().min(300).max(900),
    primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    highlightColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    outlineColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    outlineWidth: z.number().min(0).max(12),
    shadow: z.number().min(0).max(12),
    position: z.enum(['lower-third', 'middle', 'upper-third']),
    safeMarginXPx: z.number().int().min(0).max(400),
    safeMarginBottomPx: z.number().int().min(0).max(900),
    backgroundOpacity: z.number().min(0).max(1),
    uppercase: z.boolean(),
    maxCharsPerLine: z.number().int().min(10).max(60),
    maxLines: z.number().int().min(1).max(3),
  }),
});

export type BootstrapInput = z.infer<typeof bootstrapSchema>;
export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type InitiateUploadInput = z.infer<typeof initiateUploadSchema>;
export type ImportUrlInput = z.infer<typeof importUrlSchema>;
export type CreateJobInput = z.infer<typeof createJobSchema>;
export type PublishingToggleInput = z.infer<typeof publishingToggleSchema>;
export type BrandProfileInput = z.infer<typeof brandProfileSchema>;
export type SubtitlePresetInput = z.infer<typeof subtitlePresetSchema>;

// ------------------------- Telegram notifications -------------------------

/** A Telegram chat id is a signed integer, or an @channelusername. Anything else is rejected here
 *  rather than at the Telegram API, so the operator gets a field error instead of a 400. */
const telegramChatIdSchema = z
  .string()
  .trim()
  .min(2)
  .max(64)
  .refine((value) => /^-?\d{4,20}$/.test(value) || /^@[A-Za-z0-9_]{5,32}$/.test(value), {
    message: 'Use a numeric chat id (e.g. -1001234567890) or @channelusername',
  });

export const notificationSettingsSchema = z.object({
  enabled: z.boolean(),
  chatId: telegramChatIdSchema.nullable().optional(),
  categories: z.array(z.enum(NOTIFICATION_CATEGORIES)).max(NOTIFICATION_CATEGORIES.length).optional(),
  dailySummaryHour: z.number().int().min(0).max(23).optional(),
});

export const notificationHistoryQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(1000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  category: z.enum(NOTIFICATION_CATEGORIES).optional(),
  status: z.enum(['PENDING', 'SENT', 'FAILED', 'SKIPPED']).optional(),
});

export const notificationTestSchema = z.object({
  /** Free-text prefix so a test message is recognisably a test. */
  note: z.string().trim().max(200).optional(),
});

export type NotificationSettingsInput = z.infer<typeof notificationSettingsSchema>;

export * from './domain';
