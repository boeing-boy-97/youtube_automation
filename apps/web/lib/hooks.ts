'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, setCsrfToken } from './api';

export interface ComponentHealth {
  component: string;
  status: 'healthy' | 'degraded' | 'down' | 'unconfigured';
  message: string;
  latencyMs?: number;
}

export interface SessionResponse {
  authenticated: boolean;
  csrfToken?: string;
  user?: { id: string; email: string; displayName: string; role: string };
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

export function useLogin() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { email: string; password: string }) => api<{ csrfToken: string }>('/api/auth/login', { method: 'POST', body: input }),
    // The session query is refetched *before* the caller navigates, otherwise the shell can
    // observe the previous `authenticated: false` cache entry and bounce the user back to /login.
    onSuccess: async (data) => {
      setCsrfToken(data.csrfToken);
      await client.invalidateQueries({ queryKey: ['session'] });
    },
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

export function useSystemOverview() {
  return useQuery({ queryKey: ['system'], queryFn: () => api<SystemOverview>('/api/system/overview'), refetchInterval: 10_000 });
}
