'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, setCsrfToken } from './api';

export interface ComponentHealth {
  component: string;
  status: 'healthy' | 'degraded' | 'down' | 'unconfigured';
  message: string;
  latencyMs?: number;
}

export interface SignInProviders {
  password: boolean;
  selfRegistrationEnabled: boolean;
  firebase: {
    enabled: boolean;
    config: { apiKey: string; authDomain: string; projectId: string; appId: string | null } | null;
    allowNewUsers: boolean;
    error: string | null;
  };
}

export interface SessionResponse {
  authenticated: boolean;
  selfRegistrationEnabled?: boolean;
  csrfToken?: string;
  user?: { id: string; email: string; displayName: string; role: string; avatarUrl?: string | null; authMethods?: string[] };
  workspace?: { id: string; name: string; slug: string; timezone: string | null };
  configuration?: { processingReady: boolean; publishingReady: boolean; missing: string[] };
  integrations?: Record<string, boolean>;
}

export function useSession() {
  return useQuery({
    queryKey: ['session'],
    queryFn: async () => {
      const session = await api<SessionResponse>('/api/auth/session');
      if (session.authenticated && session.csrfToken) setCsrfToken(session.csrfToken);
      return session;
    },
    retry: false,
    refetchOnWindowFocus: false,
  });
}

/** Which sign-in methods the deployment offers. Public, cached, never retried aggressively. */
export function useSignInProviders() {
  return useQuery({
    queryKey: ['sign-in-providers'],
    queryFn: () => api<SignInProviders>('/api/auth/providers'),
    staleTime: 5 * 60_000,
    retry: false,
  });
}

/** Exchanges a Firebase ID token for the same httpOnly session a password login produces. */
export function useFirebaseLogin() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { idToken: string }) => api<{ csrfToken: string }>('/api/auth/firebase', { method: 'POST', body: input }),
    onSuccess: async (data) => {
      setCsrfToken(data.csrfToken);
      await client.invalidateQueries({ queryKey: ['session'] });
    },
  });
}

/** What `POST /api/auth/login` returns: a session, or the challenges of a second factor. */
export type LoginResult =
  | { csrfToken: string; userId: string; workspaceId: string }
  | {
      otpRequired: true;
      mode: 'EMAIL' | 'TELEGRAM' | 'DUAL';
      challenges: { challengeId: string; channel: 'EMAIL' | 'TELEGRAM'; destination: string; expiresAt: string; attemptsRemaining: number }[];
      resendAfterSeconds: number;
      deliveryProblem: { channel: string; error: string } | null;
    };

export function useLogin() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { email: string; password: string }) => api<LoginResult>('/api/auth/login', { method: 'POST', body: input }),
    // The session query is refetched *before* the caller navigates, otherwise the shell can
    // observe the previous `authenticated: false` cache entry and bounce the user back to /login.
    // When a second factor is required there is no session yet, so there is nothing to invalidate.
    onSuccess: async (data) => {
      if ('otpRequired' in data) return;
      setCsrfToken(data.csrfToken);
      await client.invalidateQueries({ queryKey: ['session'] });
    },
  });
}

export interface SecuritySession {
  id: string;
  device: string;
  userAgent: string | null;
  ipAddress: string | null;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  current: boolean;
}

export interface SecurityOverview {
  email: string;
  otpMode: 'OFF' | 'EMAIL' | 'TELEGRAM' | 'DUAL';
  emailVerified: boolean;
  telegram: { linked: boolean; chatId: string | null; linkedAt: string | null };
  channels: { email: boolean; telegram: boolean };
  sessions: SecuritySession[];
  recoveryCodes: { remaining: number; total: number };
  policies: { otpTtlSeconds: number; resendCooldownSeconds: number; maxAttempts: number };
}

export interface LoginEventRow {
  id: string;
  outcome: 'SUCCESS' | 'FAILED_PASSWORD' | 'OTP_CHALLENGE' | 'OTP_FAILED' | 'BLOCKED';
  method: 'PASSWORD' | 'FIREBASE' | 'OTP' | 'RECOVERY_CODE' | 'BOOTSTRAP';
  ipAddress: string | null;
  device: string;
  suspicious: boolean;
  detail: string | null;
  createdAt: string;
}

export function useSecurityOverview() {
  return useQuery({
    queryKey: ['security'],
    queryFn: () => api<SecurityOverview>('/api/auth/security/overview'),
    refetchOnWindowFocus: false,
  });
}

export function useSetOtpMode() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (mode: SecurityOverview['otpMode']) =>
      api<{ otpMode: string }>('/api/auth/security/otp-mode', { method: 'PUT', body: { mode } }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['security'] }),
  });
}

export function useRevokeSession() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<{ revoked: boolean }>(`/api/auth/security/sessions/${id}`, { method: 'DELETE' }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['security'] }),
  });
}

export function useRevokeAllSessions() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (keepCurrent: boolean) =>
      api<{ revoked: number }>('/api/auth/security/sessions/revoke-all', { method: 'POST', body: { keepCurrent } }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['security'] }),
  });
}

export function useLoginHistory() {
  return useQuery({
    queryKey: ['security', 'logins'],
    queryFn: () => api<LoginEventRow[]>('/api/auth/security/login-history'),
    refetchOnWindowFocus: false,
  });
}

export function useGenerateRecoveryCodes() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api<{ codes: string[]; remaining: number }>('/api/auth/security/recovery-codes', { method: 'POST' }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['security'] }),
  });
}

export function useCompleteStepUp() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { challengeIds: string[]; codes: string[] }) =>
      api<{ csrfToken: string; userId: string; workspaceId: string }>('/api/auth/security/otp/step-up/complete', { method: 'POST', body: input }),
    onSuccess: async (data) => {
      setCsrfToken(data.csrfToken);
      await client.invalidateQueries({ queryKey: ['session'] });
    },
  });
}

export function useResendOtp() {
  return useMutation({
    mutationFn: (challengeId: string) =>
      api<{ challenge: { challengeId: string; destination: string; expiresAt: string } }>('/api/auth/security/otp/resend', {
        method: 'POST',
        body: { challengeId },
      }),
  });
}

export function useStartTelegramLink() {
  return useMutation({
    mutationFn: (chatId: string) =>
      api<{ challengeId: string; destination: string; expiresAt: string }>('/api/auth/security/telegram/link/start', {
        method: 'POST',
        body: { chatId },
      }),
  });
}

export function useCompleteTelegramLink() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { challengeId: string; code: string; chatId: string }) =>
      api<{ linked: boolean; chatId: string }>('/api/auth/security/telegram/link/complete', { method: 'POST', body: input }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['security'] }),
  });
}

export function useUnlinkTelegram() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api<{ linked: boolean }>('/api/auth/security/telegram/unlink', { method: 'POST', body: {} }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['security'] }),
  });
}

export function useBootstrap() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { bootstrapToken: string; email: string; password: string; displayName: string; workspaceName: string }) =>
      api<{ csrfToken: string }>('/api/auth/bootstrap', { method: 'POST', body: input }),
    onSuccess: async (data) => {
      setCsrfToken(data.csrfToken);
      await client.invalidateQueries({ queryKey: ['session'] });
    },
  });
}

export function useRegister() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { email: string; password: string; displayName: string; workspaceName: string }) =>
      api<{ csrfToken: string }>('/api/auth/register', { method: 'POST', body: input }),
    onSuccess: async (data) => {
      setCsrfToken(data.csrfToken);
      await client.invalidateQueries({ queryKey: ['session'] });
    },
  });
}

export function useLogout() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api('/api/auth/logout', { method: 'POST' }),
    onSuccess: async () => {
      setCsrfToken(null);
      await client.invalidateQueries({ queryKey: ['session'] });
    },
  });
}

export interface DashboardSummary {
  counts: { sources: number; clips: number; published: number; processing: number; failed: number; publishingFailed: number; pendingPublishingJobs: number };
  publishedByPlatform: Array<{ platform: string; count: number }>;
  variantBreakdown: Array<{ durationKind: number; count: number }>;
  recentJobs: Array<{ id: string; status: string; stage: string; progressPercent: number; createdAt: string; fileName: string | null; durationSeconds: number | null }>;
  recentClips: Array<{ id: string; title: string; durationKind: number; qualityScore: number; status: string; createdAt: string }>;
  recentActivity: Array<{ id: string; action: string; summary: string; createdAt: string }>;
}

export function useDashboard() {
  return useQuery({ queryKey: ['dashboard'], queryFn: () => api<DashboardSummary>('/api/dashboard/summary'), refetchInterval: 10_000 });
}


export interface JobSummary {
  id: string;
  status: string;
  stage: string;
  progressPercent: number;
  progressDetail: string | null;
  attempt: number;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  completedAt: string | null;
  source: { id: string; originalFileName: string | null; durationSeconds: number | null };
  clipCount: number;
}

export function useJobs() {
  return useQuery({
    queryKey: ['jobs'],
    queryFn: () => api<{ items: JobSummary[]; total: number }>('/api/jobs?pageSize=50'),
    refetchInterval: 5_000,
  });
}

export interface JobDetail extends JobSummary {
  maxAttempts: number;
  workerId: string | null;
  heartbeatAt: string | null;
  leaseExpiresAt: string | null;
  source: { id: string; originalFileName: string | null; durationSeconds: number | null; width: number | null; height: number | null; mediaUrl: string };
  configuration: Record<string, unknown>;
  resultSummary: Record<string, unknown> | null;
  events: Array<{
    id: string; stage: string; status: string; progressPercent: number;
    errorCode: string | null; errorMessage: string | null;
    startedAt: string | null; finishedAt: string | null; durationMs: number | null;
  }>;
  pipeline: string[];
}

export function useJob(id: string | undefined) {
  return useQuery({
    queryKey: ['job', id],
    queryFn: () => api<JobDetail>(`/api/jobs/${id}`),
    enabled: Boolean(id),
    refetchInterval: (query) => {
      const data = query.state.data as JobDetail | undefined;
      if (!data) return 3_000;
      return ['COMPLETED', 'FAILED', 'CANCELLED', 'PARTIALLY_COMPLETED', 'NEEDS_CONFIGURATION'].includes(data.status) ? false : 2_500;
    },
  });
}

export interface ClipSummary {
  id: string;
  title: string;
  contentCategory: string;
  qualityScore: number;
  status: string;
  startSeconds: number;
  endSeconds: number;
  durationKind: number;
  jobId: string;
  createdAt: string;
  variants: Array<{ id: string; width: number; height: number; fps: number; durationSeconds: number | null; sizeBytes: number | null; previewUrl: string | null; downloadUrl: string | null; renderReport: Record<string, unknown> | null }>;
  metadata: Array<{ platform: string; title: string | null; description: string | null; hashtags: string[]; tags: string[]; reviewStatus: string }>;
  publishing: Array<{ id: string; platform: string; status: string; externalId: string | null; externalUrl: string | null; errorMessage: string | null; account: string }>;
}

export function useClips(filters: { durationKind?: number; status?: string } = {}) {
  const params = new URLSearchParams({ pageSize: '50' });
  if (filters.durationKind) params.set('durationKind', String(filters.durationKind));
  if (filters.status) params.set('status', filters.status);
  return useQuery({
    queryKey: ['clips', filters],
    queryFn: () => api<{ items: ClipSummary[]; total: number }>(`/api/clips?${params.toString()}`),
    refetchInterval: 8_000,
  });
}

export function useClip(id: string | null) {
  return useQuery({
    queryKey: ['clip', id],
    queryFn: () => api<ClipSummary & {
      candidate: { hook: string; reason: string; transcript: string; visualContext: string | null; scores: Record<string, number>; confidence: number } | null;
      source: { id: string; fileName: string | null; durationSeconds: number | null; youTubeReferenceUrl: string | null };
      publishingDetail: Array<{ id: string; platform: string; status: string; externalId: string | null; externalUrl: string | null; attempt: number; errorCode: string | null; errorMessage: string | null; retryable: boolean | null; attempts: Array<{ attemptNumber: number; operation: string; httpStatus: number | null; errorCode: string | null; errorMessage: string | null; startedAt: string; durationMs: number | null }> }>;
    }>(`/api/clips/${id}`),
    enabled: Boolean(id),
  });
}

export interface ConfigurationResponse {
  values: Record<string, unknown>;
  requiredForProcessing: string[];
  requiredForPublishing: string[];
  missingForProcessing: string[];
  missingForPublishing: string[];
  subtitlePresets: Array<{ id: string; name: string; isSystem: boolean; style: Record<string, unknown> }>;
  brandProfiles: Array<{ id: string; name: string; isDefault: boolean; brandVoice: string | null; primaryColor: string | null; audienceDescription: string | null; watermarkPosition: string | null }>;
}

export function useConfiguration() {
  return useQuery({ queryKey: ['configuration'], queryFn: () => api<ConfigurationResponse>('/api/configuration') });
}

export function useSaveConfiguration() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (entries: Array<{ key: string; value: unknown }>) => api('/api/configuration', { method: 'PUT', body: { entries } }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['configuration'] });
      void client.invalidateQueries({ queryKey: ['session'] });
    },
  });
}

export interface AccountsResponse {
  accounts: Array<{
    id: string; platform: 'YOUTUBE' | 'INSTAGRAM'; externalAccountId: string; displayName: string; username: string | null;
    avatarUrl: string | null; status: string; scopes: string[]; tokenHealth: string; tokenCheckedAt: string | null;
    tokenExpiresAt: string | null; publishingEnabled: boolean; publishingConfig: Record<string, unknown> | null; lastError: string | null;
  }>;
  integrations: { youtubeConfigured: boolean; instagramConfigured: boolean; graphApiVersion: string | null };
}

export function useAccounts() {
  return useQuery({ queryKey: ['accounts'], queryFn: () => api<AccountsResponse>('/api/accounts') });
}

export function useVerifyAccount() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<{ healthy: boolean; detail: string }>(`/api/accounts/${id}/verify`, { method: 'POST' }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['accounts'] }),
  });
}

export function useDisconnectAccount() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api(`/api/accounts/${id}`, { method: 'DELETE' }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['accounts'] }),
  });
}

export interface PublishingJobRow {
  id: string; platform: string; status: string; operation: string; attempt: number; maxAttempts: number;
  externalId: string | null; externalUrl: string | null; errorCode: string | null; errorMessage: string | null;
  retryable: boolean | null; scheduledFor: string | null; createdAt: string; completedAt: string | null;
  clip: { id: string; title: string; durationKind: number };
  account: { id: string; displayName: string; platform: string };
  lastAttempt: { attemptNumber: number; operation: string; httpStatus: number | null; errorMessage: string | null; startedAt: string; durationMs: number | null } | null;
}

export function usePublishing() {
  return useQuery({
    queryKey: ['publishing'],
    queryFn: () =>
      Promise.all([
        api<{ items: PublishingJobRow[]; total: number }>('/api/publishing/jobs?pageSize=50'),
        api<{ published: Array<{ id: string; platform: string; externalId: string; externalUrl: string | null; publishedAt: string; visibility: string | null; account: string }> }>('/api/publishing/history'),
      ]).then(([jobs, history]) => ({ jobs, history })),
    refetchInterval: 8_000,
  });
}

export function useRetryPublishing() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api(`/api/publishing/${id}/retry`, { method: 'POST' }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['publishing'] }),
  });
}

export function useActivity(limit = 100) {
  return useQuery({
    queryKey: ['activity', limit],
    queryFn: () => api<{ items: Array<{ id: string; action: string; summary: string; targetType: string | null; targetId: string | null; createdAt: string }> }>(`/api/activity?limit=${limit}`),
    refetchInterval: 15_000,
  });
}

export interface SystemOverview {
  readiness: {
    ready: boolean;
    processingReady: boolean;
    components: { db: ComponentHealth; redis: ComponentHealth; storage: ComponentHealth; ai: ComponentHealth; vp: ComponentHealth; integration: ComponentHealth[] };
  };
  queues: Record<string, { waiting: number; active: number; delayed: number; failed: number; completed: number }>;
  workers: Array<{ role: string; workerId: string; alive: boolean; lastHeartbeatAgoSeconds: number; concurrency?: number }>;
  counts: Record<string, number>;
  healthEvents: Array<{ id: string; component: string; severity: string; status: string; message: string; observedAt: string }>;
  storage: { driver: string; publicUrlConfigured: boolean };
  graphApiVersion: string | null;
  timezone: string;
  uptimeSeconds: number;
}

/**
 * Operator surfaces (system, usage, workspace configuration, brand assets, OAuth accounts) are
 * OWNER/ADMIN only on the API. Pages must ask the same question rather than render a form that
 * can only fail with 403.
 */
export function useIsOperator(): boolean {
  const session = useSession();
  return ['OWNER', 'ADMIN'].includes(session.data?.user?.role ?? '');
}

export function useSystemOverview(enabled = true) {
  return useQuery({
    queryKey: ['system'],
    queryFn: () => api<SystemOverview>('/api/system/overview'),
    refetchInterval: 10_000,
    // Operator-only endpoint: members must not hammer it just to render a "forbidden" state.
    enabled,
    retry: false,
  });
}

export type DiagnosticSeverity = 'ok' | 'info' | 'warning' | 'critical';

export interface DiagnosticFinding {
  id: string;
  title: string;
  severity: DiagnosticSeverity;
  detail: string;
  action: string;
  count?: number;
  oldestSeconds?: number;
  samples?: Array<Record<string, unknown>>;
}

export interface DiagnosticsReport {
  generatedAt: string;
  version: string;
  uptimeSeconds: number;
  worst: DiagnosticSeverity;
  findings: DiagnosticFinding[];
}

/**
 * The diagnostics endpoint answers "what needs attention right now" with findings that each carry
 * a severity, a measured detail and a recommended action. Polled slower than the overview because
 * every call re-checks storage object existence.
 */
export function useDiagnostics(enabled = true) {
  return useQuery({
    queryKey: ['diagnostics'],
    queryFn: () => api<DiagnosticsReport>('/api/system/diagnostics'),
    refetchInterval: 60_000,
    enabled,
    retry: false,
  });
}

// ---------------------------- Telegram notifications ----------------------------

export interface NotificationStatusView {
  tokenConfigured: boolean;
  chatIdConfigured: boolean;
  chatIdMasked: string | null;
  enabled: boolean;
  categories: string[];
  dailySummaryHour: number;
  bot: { reachable: boolean; username: string | null; error: string | null; checkedAt: string | null };
  lastDeliveryAt: string | null;
  lastDeliveryCategory: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  last24h: { sent: number; failed: number; skipped: number };
  canSend: boolean;
  blockingReason: string | null;
}

export interface NotificationCategoryOption {
  value: string;
  label: string;
  description: string;
  severity: 'info' | 'success' | 'warning' | 'error';
  defaultEnabled: boolean;
}

export interface NotificationDeliveryRow {
  id: string;
  category: string;
  status: 'PENDING' | 'SENT' | 'FAILED' | 'SKIPPED';
  message: string;
  jobId: string | null;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  sentAt: string | null;
}

/** Status is polled slowly: a notification channel does not need sub-second freshness. */
export function useNotificationStatus(enabled = true) {
  return useQuery({
    queryKey: ['notifications', 'status'],
    queryFn: () => api<NotificationStatusView>('/api/notifications/status'),
    refetchInterval: 30_000,
    enabled,
    retry: false,
  });
}

export function useNotificationCategories(enabled = true) {
  return useQuery({
    queryKey: ['notifications', 'categories'],
    queryFn: () => api<{ categories: NotificationCategoryOption[] }>('/api/notifications/categories'),
    staleTime: 5 * 60_000,
    enabled,
    retry: false,
  });
}

export function useNotificationHistory(enabled = true, pageSize = 15) {
  return useQuery({
    queryKey: ['notifications', 'history', pageSize],
    queryFn: () =>
      api<{ items: NotificationDeliveryRow[]; total: number; page: number; pageSize: number }>(
        `/api/notifications/history?page=1&pageSize=${pageSize}`,
      ),
    enabled,
    retry: false,
  });
}

export function useUpdateNotificationSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { enabled: boolean; chatId?: string | null; categories?: string[]; dailySummaryHour?: number }) =>
      api<unknown>('/api/notifications/settings', { method: 'PUT', body }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
  });
}

export function useSendTestNotification() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (note?: string) =>
      api<{ delivered: boolean; error: string | null; attempts: number; chatIdMasked: string | null }>(
        '/api/notifications/test',
        { method: 'POST', body: { note } },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
  });
}
