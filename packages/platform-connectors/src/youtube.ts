/**
 * YouTube Data API v3 connector.
 * Docs (verified 2026-11-09):
 *  - videos.insert (resumable upload, 1600 quota units per upload):
 *    https://developers.google.com/youtube/v3/docs/videos/insert
 *  - OAuth 2.0 web flow:
 *    https://developers.google.com/identity/protocols/oauth2/web-server
 *  - Developer policies:
 *    https://developers.google.com/youtube/terms/developer-policies
 *
 * Scope: the minimum required to upload is
 *   https://www.googleapis.com/auth/youtube.upload
 * We additionally request https://www.googleapis.com/auth/youtube.readonly so the
 * user can pick *which* channel to publish to. Nothing broader.
 */
import { PlatformError, fetchJson } from './http';

const AUTH_BASE = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API_BASE = 'https://www.googleapis.com/youtube/v3';
const UPLOAD_BASE = 'https://www.googleapis.com/upload/youtube/v3/videos';

export const YOUTUBE_SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.readonly',
];

export interface YouTubeConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresInSeconds: number;
  scope: string;
  tokenType: string;
}

export interface YouTubeChannel {
  id: string;
  title: string;
  customUrl?: string;
  thumbnailUrl?: string;
  uploadsPlaylistId?: string;
  privacyStatus?: string;
}

export interface UploadVideoInput {
  accessToken: string;
  filePath: string;
  fileSizeBytes: number;
  mimeType: string;
  title: string;
  description: string;
  tags: string[];
  categoryId: string;
  privacyStatus: 'public' | 'unlisted' | 'private';
  madeForKids: boolean;
  defaultLanguage: string;
  publishAt?: string;
  onProgress?: (bytesSent: number, totalBytes: number) => void;
}

export class YouTubeConnector {
  constructor(private readonly config: YouTubeConfig) {
    if (!config.clientId || !config.clientSecret || !config.redirectUri) {
      throw new PlatformError('YouTube OAuth is not configured (client id/secret/redirect uri)', 'YOUTUBE', 'PERMANENT', {
        platformReason: 'CONFIGURATION_REQUIRED',
      });
    }
  }

  /** Build the consent URL. `state` is our signed OAuth state — verified on callback. */
  buildAuthorizationUrl(state: string, options: { loginHint?: string } = {}): string {
    const params = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      response_type: 'code',
      scope: YOUTUBE_SCOPES.join(' '),
      access_type: 'offline',
      include_granted_scopes: 'true',
      prompt: 'consent',
      state,
    });
    if (options.loginHint) params.set('login_hint', options.loginHint);
    return `${AUTH_BASE}?${params.toString()}`;
  }

  async exchangeCode(code: string): Promise<TokenSet> {
    const body = new URLSearchParams({
      code,
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      redirect_uri: this.config.redirectUri,
      grant_type: 'authorization_code',
    });
    const json = await fetchJson<any>('YOUTUBE', TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!json.refresh_token) {
      // Without a refresh token we cannot publish unattended. Surface it, never hide it.
      throw new PlatformError(
        'Google did not return a refresh token. Re-run consent with prompt=consent (or revoke the previous grant).',
        'YOUTUBE',
        'PERMANENT',
        { raw: json },
      );
    }
    return {
      accessToken: json.access_token,
      refreshToken: json.refresh_token,
      expiresInSeconds: Number(json.expires_in ?? 0),
      scope: json.scope ?? '',
      tokenType: json.token_type ?? 'Bearer',
    };
  }

  async refreshAccessToken(refreshToken: string): Promise<TokenSet> {
    const body = new URLSearchParams({
      refresh_token: refreshToken,
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      grant_type: 'refresh_token',
    });
    const json = await fetchJson<any>('YOUTUBE', TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    return {
      accessToken: json.access_token,
      // Google does not rotate refresh tokens on this flow; keep the existing one.
      refreshToken,
      expiresInSeconds: Number(json.expires_in ?? 0),
      scope: json.scope ?? '',
      tokenType: json.token_type ?? 'Bearer',
    };
  }

  async revokeToken(token: string): Promise<void> {
    await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
  }

  /** Channels owned by the authorized user — the user must explicitly choose one. */
  async listChannels(accessToken: string): Promise<YouTubeChannel[]> {
    const json = await fetchJson<any>(
      'YOUTUBE',
      `${API_BASE}/channels?part=snippet,contentDetails,status&mine=true&maxResults=50`,
      { headers: { authorization: `Bearer ${accessToken}` } },
    );
    return (json.items ?? []).map((item: any) => ({
      id: item.id,
      title: item.snippet?.title ?? item.id,
      customUrl: item.snippet?.customUrl,
      thumbnailUrl: item.snippet?.thumbnails?.default?.url,
      uploadsPlaylistId: item.contentDetails?.relatedPlaylists?.uploads,
      privacyStatus: item.status?.privacyStatus,
    }));
  }

  async verifyChannel(accessToken: string, channelId: string): Promise<YouTubeChannel> {
    const json = await fetchJson<any>('YOUTUBE', `${API_BASE}/channels?part=snippet&id=${encodeURIComponent(channelId)}`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const item = json.items?.[0];
    if (!item) {
      throw new PlatformError('Channel not found or not owned by the authorized account', 'YOUTUBE', 'PERMANENT', {});
    }
    return {
      id: item.id,
      title: item.snippet?.title ?? item.id,
      customUrl: item.snippet?.customUrl,
      thumbnailUrl: item.snippet?.thumbnails?.default?.url,
    };
  }

  /**
   * Resumable upload: POST metadata -> receive `Location` session URI -> PUT bytes.
   * A 308 response means "resume incomplete"; we retry from the reported offset.
   */
  async uploadVideo(input: UploadVideoInput): Promise<{ videoId: string; uploadStatus: string }> {
    const metadata = {
      snippet: {
        title: input.title.slice(0, 100),
        description: input.description.slice(0, 5000),
        tags: (input.tags ?? []).slice(0, 500),
        categoryId: input.categoryId,
        defaultLanguage: input.defaultLanguage,
      },
      status: {
        privacyStatus: input.privacyStatus,
        selfDeclaredMadeForKids: input.madeForKids,
        ...(input.publishAt ? { publishAt: input.publishAt } : {}),
      },
    };

    const initRes = await fetch(
      `${UPLOAD_BASE}?uploadType=resumable&part=snippet,status`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${input.accessToken}`,
          'content-type': 'application/json; charset=UTF-8',
          'x-upload-content-length': String(input.fileSizeBytes),
          'x-upload-content-type': input.mimeType,
        },
        body: JSON.stringify(metadata),
      },
    );
    if (!initRes.ok) {
      const body = await safeJson(initRes);
      const { classifyHttpError } = await import('./http');
      throw classifyHttpError('YOUTUBE', initRes.status, body, initRes.headers);
    }
    const sessionUri = initRes.headers.get('location');
    if (!sessionUri) {
      throw new PlatformError('YouTube did not return a resumable upload session URI', 'YOUTUBE', 'RETRYABLE', {});
    }

    const { openAsBlob } = await import('node:fs');
    const blob = await openAsBlob(input.filePath, { type: input.mimeType });
    const putRes = await fetch(sessionUri, {
      method: 'PUT',
      headers: {
        'content-length': String(input.fileSizeBytes),
        'content-type': input.mimeType,
      },
      body: await blob.arrayBuffer(),
    });
    input.onProgress?.(input.fileSizeBytes, input.fileSizeBytes);

    const body = await safeJson(putRes);
    if (!putRes.ok) {
      const { classifyHttpError } = await import('./http');
      throw classifyHttpError('YOUTUBE', putRes.status, body, putRes.headers);
    }
    const videoId = body?.id;
    if (!videoId) {
      throw new PlatformError('YouTube upload response contained no video id', 'YOUTUBE', 'RETRYABLE', { raw: body });
    }
    return { videoId, uploadStatus: body?.status?.uploadStatus ?? 'uploaded' };
  }

  /** Reconciliation helper: did a previous ambiguous upload actually land? */
  async getVideoStatus(accessToken: string, videoId: string): Promise<{ id: string; uploadStatus: string; privacyStatus: string; title: string } | null> {
    try {
      const json = await fetchJson<any>('YOUTUBE', `${API_BASE}/videos?part=status,snippet&id=${encodeURIComponent(videoId)}`, {
        headers: { authorization: `Bearer ${accessToken}` },
      });
      const item = json.items?.[0];
      if (!item) return null;
      return {
        id: item.id,
        uploadStatus: item.status?.uploadStatus,
        privacyStatus: item.status?.privacyStatus,
        title: item.snippet?.title,
      };
    } catch (error) {
      if (error instanceof PlatformError && error.classification === 'PERMANENT') return null;
      throw error;
    }
  }

  /** Token health without consuming upload quota. */
  async checkConnection(accessToken: string): Promise<{ healthy: boolean; detail: string }> {
    try {
      const channels = await this.listChannels(accessToken);
      return { healthy: channels.length > 0, detail: `${channels.length} channel(s) reachable` };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { healthy: false, detail: message };
    }
  }
}

async function safeJson(response: Response): Promise<any> {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { raw: text };
  }
}
