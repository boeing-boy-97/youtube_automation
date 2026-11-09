/**
 * Instagram content publishing connector — official Meta API only.
 *
 * Documentation verified 2026-11-09:
 *  - Latest Graph API version: v27.0 (v26.0 released 2026-07-29)
 *    https://developers.facebook.com/docs/graph-api/changelog
 *  - Instagram content publishing (Reels via media_type=REELS):
 *    https://developers.facebook.com/docs/instagram-platform/content-publishing/
 *  - "Instagram API with Instagram Login" host: graph.instagram.com
 *  - Scopes: instagram_business_basic, instagram_business_content_publish
 *
 * The API version is NEVER hardcoded: it is injected from META_GRAPH_API_VERSION
 * and validated against the known-good list below. An unknown version fails loudly.
 *
 * Publish sequence implemented verbatim:
 *   POST /{ig-user-id}/media (media_type=REELS, video_url, caption, share_to_feed)
 *   GET  /{container-id}?fields=status_code   (poll: IN_PROGRESS → FINISHED | ERROR | EXPIRED)
 *   POST /{ig-user-id}/media_publish (creation_id)
 */
import { PlatformError, fetchJson } from './http';

export const SUPPORTED_GRAPH_VERSIONS = ['v21.0', 'v22.0', 'v23.0', 'v24.0', 'v25.0', 'v26.0', 'v27.0'] as const;
export type GraphVersion = (typeof SUPPORTED_GRAPH_VERSIONS)[number];

export const INSTAGRAM_SCOPES = ['instagram_business_basic', 'instagram_business_content_publish'];

export interface InstagramConfig {
  appId: string;
  appSecret: string;
  redirectUri: string;
  graphVersion: string;
}

export interface InstagramToken {
  accessToken: string;
  expiresInSeconds: number;
  userId?: string;
}

export interface InstagramAccount {
  id: string;
  username: string;
  accountType?: string;
  profilePictureUrl?: string;
  mediaCount?: number;
}

export type ContainerStatus = 'EXPIRED' | 'ERROR' | 'FINISHED' | 'IN_PROGRESS' | 'PUBLISHED';

export class InstagramConnector {
  private readonly version: string;

  constructor(private readonly config: InstagramConfig) {
    if (!config.appId || !config.appSecret || !config.redirectUri) {
      throw new PlatformError('Instagram app credentials are not configured', 'INSTAGRAM', 'PERMANENT', {
        platformReason: 'CONFIGURATION_REQUIRED',
      });
    }
    if (!SUPPORTED_GRAPH_VERSIONS.includes(config.graphVersion as GraphVersion)) {
      throw new PlatformError(
        `META_GRAPH_API_VERSION "${config.graphVersion}" is not a verified supported version (${SUPPORTED_GRAPH_VERSIONS.join(', ')}). Update configuration.`,
        'INSTAGRAM',
        'PERMANENT',
        { platformReason: 'UNSUPPORTED_API_VERSION' },
      );
    }
    this.version = config.graphVersion;
  }

  get apiVersion(): string {
    return this.version;
  }

  buildAuthorizationUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: this.config.appId,
      redirect_uri: this.config.redirectUri,
      response_type: 'code',
      scope: INSTAGRAM_SCOPES.join(','),
      state,
    });
    return `https://www.instagram.com/oauth/authorize?${params.toString()}`;
  }

  /** Authorization code -> short-lived token (api.instagram.com/oauth/access_token). */
  async exchangeCode(code: string): Promise<InstagramToken> {
    const body = new URLSearchParams({
      client_id: this.config.appId,
      client_secret: this.config.appSecret,
      grant_type: 'authorization_code',
      redirect_uri: this.config.redirectUri,
      code,
    });
    const json = await fetchJson<any>('INSTAGRAM', 'https://api.instagram.com/oauth/access_token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!json.access_token) {
      throw new PlatformError('Instagram did not return an access token', 'INSTAGRAM', 'PERMANENT', { raw: json });
    }
    return { accessToken: json.access_token, expiresInSeconds: Number(json.expires_in ?? 3600), userId: json.user_id?.toString() };
  }

  /** Short-lived (1h) -> long-lived (60d) token. */
  async exchangeForLongLived(shortToken: string): Promise<InstagramToken> {
    const url = new URL(`https://graph.instagram.com/access_token`);
    url.searchParams.set('grant_type', 'ig_exchange_token');
    url.searchParams.set('client_secret', this.config.appSecret);
    url.searchParams.set('access_token', shortToken);
    const json = await fetchJson<any>('INSTAGRAM', url.toString(), { method: 'GET' });
    if (!json.access_token) {
      throw new PlatformError('Instagram long-lived token exchange failed', 'INSTAGRAM', 'PERMANENT', { raw: json });
    }
    return { accessToken: json.access_token, expiresInSeconds: Number(json.expires_in ?? 5_184_000) };
  }

  /** Refresh a long-lived token (must be >24h old and not expired). */
  async refreshLongLived(longLivedToken: string): Promise<InstagramToken> {
    const url = new URL('https://graph.instagram.com/refresh_access_token');
    url.searchParams.set('grant_type', 'ig_refresh_token');
    url.searchParams.set('access_token', longLivedToken);
    const json = await fetchJson<any>('INSTAGRAM', url.toString(), { method: 'GET' });
    return { accessToken: json.access_token, expiresInSeconds: Number(json.expires_in ?? 5_184_000) };
  }

  private base(): string {
    return `https://graph.instagram.com/${this.version}`;
  }

  async getAccount(accessToken: string): Promise<InstagramAccount> {
    const url = `${this.base()}/me?fields=user_id,username,account_type,profile_picture_url,media_count`;
    const json = await fetchJson<any>('INSTAGRAM', url, { headers: { authorization: `Bearer ${accessToken}` } });
    return {
      id: String(json.user_id ?? json.id),
      username: json.username,
      accountType: json.account_type,
      profilePictureUrl: json.profile_picture_url,
      mediaCount: json.media_count,
    };
  }

  /** Step 1 — create the Reels container. video_url MUST be a public HTTPS URL. */
  async createReelContainer(
    igUserId: string,
    accessToken: string,
    input: { videoUrl: string; caption: string; shareToFeed: boolean; coverUrl?: string; thumbOffsetMs?: number },
  ): Promise<{ containerId: string }> {
    if (!input.videoUrl.startsWith('https://')) {
      throw new PlatformError(
        'Instagram requires a publicly reachable HTTPS video_url; the local filesystem cannot be read by Meta.',
        'INSTAGRAM',
        'PERMANENT',
        { platformReason: 'MEDIA_URL_NOT_HTTPS' },
      );
    }
    const body = new URLSearchParams({
      media_type: 'REELS',
      video_url: input.videoUrl,
      caption: input.caption.slice(0, 2200),
      share_to_feed: String(input.shareToFeed),
      access_token: accessToken,
    });
    if (input.coverUrl) body.set('cover_url', input.coverUrl);
    if (typeof input.thumbOffsetMs === 'number') body.set('thumb_offset', String(input.thumbOffsetMs));
    const json = await fetchJson<any>('INSTAGRAM', `${this.base()}/${igUserId}/media`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!json.id) {
      throw new PlatformError('Instagram did not return a container id', 'INSTAGRAM', 'PERMANENT', { raw: json });
    }
    return { containerId: String(json.id) };
  }

  /** Step 2 — poll container status. */
  async getContainerStatus(containerId: string, accessToken: string): Promise<{ status: ContainerStatus; detail?: string }> {
    const url = `${this.base()}/${containerId}?fields=status_code,status&access_token=${encodeURIComponent(accessToken)}`;
    const json = await fetchJson<any>('INSTAGRAM', url, { method: 'GET' });
    return { status: (json.status_code ?? 'IN_PROGRESS') as ContainerStatus, detail: json.status };
  }

  /** Step 3 — publish the container. */
  async publishReel(igUserId: string, accessToken: string, containerId: string): Promise<{ mediaId: string }> {
    const body = new URLSearchParams({ creation_id: containerId, access_token: accessToken });
    const json = await fetchJson<any>('INSTAGRAM', `${this.base()}/${igUserId}/media_publish`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!json.id) {
      throw new PlatformError('Instagram media_publish returned no media id', 'INSTAGRAM', 'RETRYABLE', { raw: json });
    }
    return { mediaId: String(json.id) };
  }

  /**
   * Reconciliation: list recent media to detect an ambiguous publish that actually
   * succeeded (prevents duplicate Reels after a network timeout).
   */
  async findRecentlyPublished(igUserId: string, accessToken: string): Promise<Array<{ id: string; caption?: string; timestamp?: string; permalink?: string }>> {
    const url = `${this.base()}/${igUserId}/media?fields=id,caption,timestamp,permalink&limit=10&access_token=${encodeURIComponent(accessToken)}`;
    const json = await fetchJson<any>('INSTAGRAM', url, { method: 'GET' });
    return (json.data ?? []).map((m: any) => ({ id: String(m.id), caption: m.caption, timestamp: m.timestamp, permalink: m.permalink }));
  }

  async checkConnection(accessToken: string): Promise<{ healthy: boolean; detail: string }> {
    try {
      const account = await this.getAccount(accessToken);
      return { healthy: true, detail: `@${account.username} (${account.id})` };
    } catch (error) {
      return { healthy: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }
}
