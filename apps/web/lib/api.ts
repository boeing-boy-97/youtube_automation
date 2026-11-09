export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly missingConfiguration?: string[],
    readonly details?: unknown,
  ) {
    super(message);
  }
}

let csrfToken: string | null = null;

async function ensureCsrf(): Promise<string> {
  if (csrfToken) return csrfToken;
  const response = await fetch('/api/auth/csrf', { credentials: 'include' });
  if (!response.ok) throw new ApiError('Unable to obtain a CSRF token', response.status, 'CSRF_FAILED');
  const body = (await response.json()) as { csrfToken: string };
  csrfToken = body.csrfToken;
  return csrfToken;
}

export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

export async function api<T>(path: string, options: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (!['GET', 'HEAD'].includes(method)) headers['x-csrf-token'] = await ensureCsrf();

  const response = await fetch(path, {
    method,
    headers,
    credentials: 'include',
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options.signal,
  });

  const text = await response.text();
  const payload = text ? safeJson(text) : {};
  if (!response.ok) {
    const error = (payload as { error?: { code?: string; message?: string; missingConfiguration?: string[]; details?: unknown } }).error;
    if (response.status === 401) setCsrfToken(null);
    throw new ApiError(
      error?.message ?? `Request failed with HTTP ${response.status}`,
      response.status,
      error?.code ?? 'REQUEST_FAILED',
      error?.missingConfiguration,
      error?.details,
    );
  }
  return payload as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

export interface UploadProgress {
  phase: 'initiating' | 'uploading' | 'validating' | 'done';
  uploadedBytes: number;
  totalBytes: number;
  percent: number;
}

/** Chunked upload through the API with the rights declaration sent at completion. */
export async function uploadSource(
  file: File,
  options: { youTubeReferenceUrl?: string; rightsStatement: string; onProgress?: (progress: UploadProgress) => void },
): Promise<{ id: string; status: string; durationSeconds: number | null; width: number | null; height: number | null }> {
  options.onProgress?.({ phase: 'initiating', uploadedBytes: 0, totalBytes: file.size, percent: 0 });
  const initiation = await api<{ sourceVideoId: string; partSizeBytes: number }>('/api/sources/upload/initiate', {
    method: 'POST',
    body: {
      fileName: file.name,
      mimeType: file.type || 'video/mp4',
      sizeBytes: file.size,
      ...(options.youTubeReferenceUrl ? { youTubeReferenceUrl: options.youTubeReferenceUrl } : {}),
    },
  });

  const partSize = initiation.partSizeBytes;
  let uploaded = 0;
  for (let index = 0; index * partSize < file.size; index += 1) {
    const chunk = file.slice(index * partSize, Math.min((index + 1) * partSize, file.size));
    const form = new FormData();
    form.append('chunk', chunk, 'part.bin');
    const csrf = await ensureCsrf();
    const response = await fetch(
      `/api/sources/upload/part?sourceVideoId=${initiation.sourceVideoId}&partNumber=${index + 1}`,
      { method: 'POST', body: form, credentials: 'include', headers: { 'x-csrf-token': csrf } },
    );
    if (!response.ok) {
      const body = await response.text();
      throw new ApiError(`Chunk ${index + 1} failed: ${body.slice(0, 300)}`, response.status, 'UPLOAD_FAILED');
    }
    uploaded += chunk.size;
    options.onProgress?.({ phase: 'uploading', uploadedBytes: uploaded, totalBytes: file.size, percent: Math.round((uploaded / file.size) * 100) });
  }

  options.onProgress?.({ phase: 'validating', uploadedBytes: file.size, totalBytes: file.size, percent: 100 });
  const result = await api<{ id: string; status: string; durationSeconds: number | null; width: number | null; height: number | null }>(
    '/api/sources/upload/complete',
    { method: 'POST', body: { sourceVideoId: initiation.sourceVideoId, rightsDeclaration: { accepted: true, statement: options.rightsStatement } } },
  );
  options.onProgress?.({ phase: 'done', uploadedBytes: file.size, totalBytes: file.size, percent: 100 });
  return result;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '\u2014';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return '\u2014';
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}

export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return '\u2014';
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(diff / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}
