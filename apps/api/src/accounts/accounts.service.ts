import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  appendAuditLog,
  decryptSecret,
  encryptSecret,
  prisma,
} from '@clipforge/database';
import {
  InstagramConnector,
  PlatformError,
  YouTubeConnector,
} from '@clipforge/platform-connectors';
import { randomBytes, createHmac } from 'node:crypto';
import { env } from '../common/env';
import { RedisService } from '../common/services/redis.service';
import type { RequestContext } from '../common/guards/session-auth.guard';

const STATE_TTL_SECONDS = 600;

export interface OAuthStatePayload {
  workspaceId: string;
  userId: string;
  platform: 'YOUTUBE' | 'INSTAGRAM';
  returnTo: string;
  nonce: string;
  issuedAt: number;
}

@Injectable()
export class AccountsService {
  private readonly logger = new Logger(AccountsService.name);

  constructor(private readonly redis: RedisService) {}

  // ------------------------------ connectors ------------------------------

  youtubeConnector(): YouTubeConnector {
    if (!env.YOUTUBE_CLIENT_ID || !env.YOUTUBE_CLIENT_SECRET || !env.YOUTUBE_REDIRECT_URI) {
      throw new BadRequestException({
        code: 'CONFIGURATION_REQUIRED',
        message: 'YouTube OAuth is not configured. Set YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET and YOUTUBE_REDIRECT_URI.',
        details: { missingConfiguration: ['YOUTUBE_CLIENT_ID', 'YOUTUBE_CLIENT_SECRET', 'YOUTUBE_REDIRECT_URI'] },
      });
    }
    return new YouTubeConnector({
      clientId: env.YOUTUBE_CLIENT_ID,
      clientSecret: env.YOUTUBE_CLIENT_SECRET,
      redirectUri: env.YOUTUBE_REDIRECT_URI,
    });
  }

  instagramConnector(): InstagramConnector {
    if (!env.META_APP_ID || !env.META_APP_SECRET || !env.META_REDIRECT_URI || !env.META_GRAPH_API_VERSION) {
      throw new BadRequestException({
        code: 'CONFIGURATION_REQUIRED',
        message: 'Instagram is not configured. Set META_APP_ID, META_APP_SECRET, META_REDIRECT_URI and META_GRAPH_API_VERSION.',
        details: {
          missingConfiguration: ['META_APP_ID', 'META_APP_SECRET', 'META_REDIRECT_URI', 'META_GRAPH_API_VERSION'],
        },
      });
    }
    return new InstagramConnector({
      appId: env.META_APP_ID,
      appSecret: env.META_APP_SECRET,
      redirectUri: env.META_REDIRECT_URI,
      graphVersion: env.META_GRAPH_API_VERSION,
    });
  }

  // -------------------------------- state ----------------------------------

  /** Signed, single-use, server-stored OAuth state (Redis, 10 minute TTL). */
  async issueState(ctx: RequestContext, platform: 'YOUTUBE' | 'INSTAGRAM'): Promise<string> {
    const payload: OAuthStatePayload = {
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      platform,
      returnTo: `${env.APP_URL}/accounts`,
      nonce: randomBytes(16).toString('hex'),
      issuedAt: Date.now(),
    };
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = createHmac('sha256', env.SESSION_SECRET).update(body).digest('base64url');
    const state = `${body}.${signature}`;
    await this.redis.client.set(this.redis.key('oauth-state', payload.nonce), JSON.stringify(payload), 'EX', STATE_TTL_SECONDS);
    return state;
  }

  async consumeState(state: string): Promise<OAuthStatePayload> {
    const [body, signature] = state.split('.');
    if (!body || !signature) throw new BadRequestException({ code: 'VALIDATION_FAILED', message: 'Malformed OAuth state' });
    const expected = createHmac('sha256', env.SESSION_SECRET).update(body).digest('base64url');
    if (expected !== signature) throw new BadRequestException({ code: 'FORBIDDEN', message: 'OAuth state signature mismatch' });
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as OAuthStatePayload;
    const key = this.redis.key('oauth-state', payload.nonce);
    const stored = await this.redis.client.get(key);
    if (!stored) throw new BadRequestException({ code: 'FORBIDDEN', message: 'OAuth state expired or already used' });
    await this.redis.client.del(key);
    if (Date.now() - payload.issuedAt > STATE_TTL_SECONDS * 1000) {
      throw new BadRequestException({ code: 'FORBIDDEN', message: 'OAuth state expired' });
    }
    return payload;
  }

  // ------------------------------- YouTube ---------------------------------

  async startYouTube(ctx: RequestContext) {
    const connector = this.youtubeConnector();
    const state = await this.issueState(ctx, 'YOUTUBE');
    return { authorizationUrl: connector.buildAuthorizationUrl(state, { loginHint: ctx.email }) };
  }

  /**
   * Callback: exchange the code, then require the user to explicitly select a
   * channel. Nothing is connected until that selection is confirmed.
   */
  async handleYouTubeCallback(code: string, state: string) {
    const payload = await this.consumeState(state);
    if (payload.platform !== 'YOUTUBE') throw new BadRequestException({ code: 'VALIDATION_FAILED', message: 'State platform mismatch' });

    const connector = this.youtubeConnector();
    const tokens = await connector.exchangeCode(code);
    const channels = await connector.listChannels(tokens.accessToken);
    if (channels.length === 0) {
      throw new BadRequestException({ code: 'CONFIGURATION_REQUIRED', message: 'The authorized Google account has no YouTube channel' });
    }

    const pendingToken = randomBytes(24).toString('hex');
    await this.redis.client.set(
      this.redis.key('oauth-pending-youtube', pendingToken),
      JSON.stringify({
        workspaceId: payload.workspaceId,
        userId: payload.userId,
        tokens,
        channels,
      }),
      'EX',
      STATE_TTL_SECONDS,
    );
    return { workspaceId: payload.workspaceId, requiresChannelSelection: true, pendingToken, channels };
  }

  async completeYouTubeSelection(pendingToken: string, channelId: string, ctx: RequestContext) {
    const raw = await this.redis.client.get(this.redis.key('oauth-pending-youtube', pendingToken));
    if (!raw) throw new BadRequestException({ code: 'FORBIDDEN', message: 'YouTube authorization expired; start again' });
    const pending = JSON.parse(raw) as {
      workspaceId: string;
      userId: string;
      tokens: { accessToken: string; refreshToken?: string; expiresInSeconds: number; scope: string; tokenType: string };
      channels: Array<{ id: string; title: string; thumbnailUrl?: string; customUrl?: string }>;
    };
    if (pending.workspaceId !== ctx.workspaceId || pending.userId !== ctx.userId) {
      throw new BadRequestException({ code: 'FORBIDDEN', message: 'This authorization belongs to another session' });
    }
    const channel = pending.channels.find((c) => c.id === channelId);
    if (!channel) throw new BadRequestException({ code: 'VALIDATION_FAILED', message: 'Selected channel was not in the authorized list' });

    const account = await this.upsertAccount({
      workspaceId: pending.workspaceId,
      platform: 'YOUTUBE',
      externalAccountId: channel.id,
      displayName: channel.title,
      username: channel.customUrl ?? null,
      avatarUrl: channel.thumbnailUrl ?? null,
      scopes: pending.tokens.scope.split(' ').filter(Boolean),
      accessToken: pending.tokens.accessToken,
      refreshToken: pending.tokens.refreshToken ?? null,
      expiresInSeconds: pending.tokens.expiresInSeconds,
      actorUserId: ctx.userId,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    await this.redis.client.del(this.redis.key('oauth-pending-youtube', pendingToken));
    return account;
  }

  // ------------------------------ Instagram --------------------------------

  async startInstagram(ctx: RequestContext) {
    const connector = this.instagramConnector();
    const state = await this.issueState(ctx, 'INSTAGRAM');
    return { authorizationUrl: connector.buildAuthorizationUrl(state), apiVersion: connector.apiVersion };
  }

  async handleInstagramCallback(code: string, state: string) {
    const payload = await this.consumeState(state);
    if (payload.platform !== 'INSTAGRAM') throw new BadRequestException({ code: 'VALIDATION_FAILED', message: 'State platform mismatch' });
    const connector = this.instagramConnector();

    const shortLived = await connector.exchangeCode(code);
    const longLived = await connector.exchangeForLongLived(shortLived.accessToken);
    const profile = await connector.getAccount(longLived.accessToken);

    return this.upsertAccount({
      workspaceId: payload.workspaceId,
      platform: 'INSTAGRAM',
      externalAccountId: profile.id,
      displayName: profile.username,
      username: profile.username,
      avatarUrl: profile.profilePictureUrl ?? null,
      scopes: ['instagram_business_basic', 'instagram_business_content_publish'],
      accessToken: longLived.accessToken,
      refreshToken: null,
      expiresInSeconds: longLived.expiresInSeconds,
      actorUserId: payload.userId,
      ip: null,
      userAgent: null,
    });
  }

  // ------------------------------- storage ---------------------------------

  private async upsertAccount(input: {
    workspaceId: string;
    platform: 'YOUTUBE' | 'INSTAGRAM';
    externalAccountId: string;
    displayName: string;
    username: string | null;
    avatarUrl: string | null;
    scopes: string[];
    accessToken: string;
    refreshToken: string | null;
    expiresInSeconds: number;
    actorUserId: string;
    ip: string | null;
    userAgent: string | null;
  }) {
    const expiresAt = input.expiresInSeconds > 0 ? new Date(Date.now() + input.expiresInSeconds * 1000) : null;
    const account = await prisma.connectedAccount.upsert({
      where: {
        workspaceId_platform_externalAccountId: {
          workspaceId: input.workspaceId,
          platform: input.platform,
          externalAccountId: input.externalAccountId,
        },
      },
      update: {
        displayName: input.displayName,
        username: input.username,
        avatarUrl: input.avatarUrl,
        status: 'CONNECTED',
        scopes: input.scopes,
        tokenHealth: 'VALID',
        tokenCheckedAt: new Date(),
        disconnectedAt: null,
        lastError: null,
        connectedAt: new Date(),
      },
      create: {
        workspaceId: input.workspaceId,
        platform: input.platform,
        externalAccountId: input.externalAccountId,
        displayName: input.displayName,
        username: input.username,
        avatarUrl: input.avatarUrl,
        status: 'CONNECTED',
        scopes: input.scopes,
        tokenHealth: 'VALID',
        tokenCheckedAt: new Date(),
        connectedAt: new Date(),
      },
    });

    await prisma.oAuthCredential.upsert({
      where: { connectedAccountId: account.id },
      update: {
        accessTokenEnc: encryptSecret(input.accessToken) as unknown as object,
        refreshTokenEnc: input.refreshToken ? (encryptSecret(input.refreshToken) as unknown as object) : undefined,
        expiresAt,
        scope: input.scopes.join(' '),
        refreshedAt: new Date(),
      },
      create: {
        connectedAccountId: account.id,
        accessTokenEnc: encryptSecret(input.accessToken) as unknown as object,
        refreshTokenEnc: input.refreshToken ? (encryptSecret(input.refreshToken) as unknown as object) : undefined,
        expiresAt,
        scope: input.scopes.join(' '),
      },
    });

    await appendAuditLog({
      workspaceId: input.workspaceId,
      userId: input.actorUserId,
      action: 'ACCOUNT_CONNECTED',
      targetType: 'ConnectedAccount',
      targetId: account.id,
      summary: `${input.platform} account ${input.displayName} connected`,
      metadata: { scopes: input.scopes, externalAccountId: input.externalAccountId },
      ipAddress: input.ip,
      userAgent: input.userAgent,
    });
    return this.toDto(account);
  }

  /**
   * Returns a usable access token, refreshing it when expired. Throws a typed
   * error when the credential can no longer be refreshed — the account is never
   * reported as connected in that case.
   */
  async getAccessToken(connectedAccountId: string): Promise<{ accessToken: string; account: { id: string; platform: 'YOUTUBE' | 'INSTAGRAM'; externalAccountId: string; workspaceId: string } }> {
    const account = await prisma.connectedAccount.findUnique({
      where: { id: connectedAccountId },
      include: { credential: true },
    });
    if (!account || !account.credential) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Connected account has no credential' });
    }
    const accessToken = decryptSecret(account.credential.accessTokenEnc);
    const expiresAt = account.credential.expiresAt;
    const expiresSoon = expiresAt ? expiresAt.getTime() - Date.now() < 5 * 60_000 : false;

    if (!expiresSoon) {
      return { accessToken, account: { id: account.id, platform: account.platform, externalAccountId: account.externalAccountId, workspaceId: account.workspaceId } };
    }

    try {
      if (account.platform === 'YOUTUBE') {
        const refreshToken = account.credential.refreshTokenEnc ? decryptSecret(account.credential.refreshTokenEnc) : null;
        if (!refreshToken) throw new PlatformError('No refresh token stored for YouTube account', 'YOUTUBE', 'AUTH');
        const refreshed = await this.youtubeConnector().refreshAccessToken(refreshToken);
        await this.persistRefreshed(account.id, refreshed.accessToken, refreshed.refreshToken ?? refreshToken, refreshed.expiresInSeconds);
        return { accessToken: refreshed.accessToken, account: { id: account.id, platform: account.platform, externalAccountId: account.externalAccountId, workspaceId: account.workspaceId } };
      }
      const refreshed = await this.instagramConnector().refreshLongLived(accessToken);
      await this.persistRefreshed(account.id, refreshed.accessToken, null, refreshed.expiresInSeconds);
      return { accessToken: refreshed.accessToken, account: { id: account.id, platform: account.platform, externalAccountId: account.externalAccountId, workspaceId: account.workspaceId } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await prisma.connectedAccount.update({
        where: { id: account.id },
        data: { status: 'EXPIRED', tokenHealth: 'EXPIRED', tokenCheckedAt: new Date(), lastError: message.slice(0, 900) },
      });
      await appendAuditLog({
        workspaceId: account.workspaceId,
        userId: null,
        action: 'ACCOUNT_TOKEN_REFRESHED',
        targetType: 'ConnectedAccount',
        targetId: account.id,
        summary: `Token refresh failed for ${account.platform}: ${message}`,
      });
      throw error;
    }
  }

  private async persistRefreshed(accountId: string, accessToken: string, refreshToken: string | null, expiresInSeconds: number) {
    await prisma.oAuthCredential.update({
      where: { connectedAccountId: accountId },
      data: {
        accessTokenEnc: encryptSecret(accessToken) as unknown as object,
        ...(refreshToken ? { refreshTokenEnc: encryptSecret(refreshToken) as unknown as object } : {}),
        expiresAt: expiresInSeconds > 0 ? new Date(Date.now() + expiresInSeconds * 1000) : null,
        refreshedAt: new Date(),
      },
    });
    await prisma.connectedAccount.update({
      where: { id: accountId },
      data: { tokenHealth: 'VALID', tokenCheckedAt: new Date(), status: 'CONNECTED', lastError: null },
    });
  }

  // ------------------------------- queries ---------------------------------

  async list(ctx: RequestContext) {
    const accounts = await prisma.connectedAccount.findMany({
      where: { workspaceId: ctx.workspaceId },
      include: { credential: { select: { expiresAt: true, refreshedAt: true, scope: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return {
      accounts: accounts.map((a) => ({
        ...this.toDto(a),
        tokenExpiresAt: a.credential?.expiresAt?.toISOString() ?? null,
        tokenRefreshedAt: a.credential?.refreshedAt?.toISOString() ?? null,
      })),
      integrations: {
        youtubeConfigured: Boolean(env.YOUTUBE_CLIENT_ID && env.YOUTUBE_CLIENT_SECRET && env.YOUTUBE_REDIRECT_URI),
        instagramConfigured: Boolean(env.META_APP_ID && env.META_APP_SECRET && env.META_REDIRECT_URI && env.META_GRAPH_API_VERSION),
        graphApiVersion: env.META_GRAPH_API_VERSION ?? null,
      },
    };
  }

  async verify(accountId: string, ctx: RequestContext) {
    const account = await prisma.connectedAccount.findFirst({ where: { id: accountId, workspaceId: ctx.workspaceId } });
    if (!account) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Account not found' });
    let result: { healthy: boolean; detail: string };
    try {
      const { accessToken } = await this.getAccessToken(accountId);
      result =
        account.platform === 'YOUTUBE'
          ? await this.youtubeConnector().checkConnection(accessToken)
          : await this.instagramConnector().checkConnection(accessToken);
    } catch (error) {
      result = { healthy: false, detail: error instanceof Error ? error.message : String(error) };
    }
    await prisma.connectedAccount.update({
      where: { id: accountId },
      data: {
        tokenHealth: result.healthy ? 'VALID' : 'INVALID',
        tokenCheckedAt: new Date(),
        status: result.healthy ? 'CONNECTED' : 'ERROR',
        lastError: result.healthy ? null : result.detail.slice(0, 900),
      },
    });
    return result;
  }

  async disconnect(accountId: string, ctx: RequestContext) {
    const account = await prisma.connectedAccount.findFirst({ where: { id: accountId, workspaceId: ctx.workspaceId } });
    if (!account) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Account not found' });

    // Best-effort revocation at the platform, then local removal of secrets.
    try {
      const credential = await prisma.oAuthCredential.findUnique({ where: { connectedAccountId: accountId } });
      if (credential && account.platform === 'YOUTUBE') {
        await this.youtubeConnector().revokeToken(decryptSecret(credential.accessTokenEnc));
      }
    } catch (error) {
      this.logger.warn(`Token revocation failed for ${accountId}: ${(error as Error).message}`);
    }

    await prisma.$transaction(async (tx) => {
      await tx.oAuthCredential.deleteMany({ where: { connectedAccountId: accountId } });
      await tx.connectedAccount.update({
        where: { id: accountId },
        data: { status: 'REVOKED', publishingEnabled: false, disconnectedAt: new Date(), tokenHealth: 'INVALID' },
      });
    });
    await appendAuditLog({
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      action: 'ACCOUNT_DISCONNECTED',
      targetType: 'ConnectedAccount',
      targetId: accountId,
      summary: `${account.platform} account ${account.displayName} disconnected`,
      ipAddress: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return { disconnected: true };
  }

  async assertPublishable(accountId: string, workspaceId: string) {
    const account = await prisma.connectedAccount.findFirst({ where: { id: accountId, workspaceId } });
    if (!account) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Connected account not found' });
    if (account.status !== 'CONNECTED') {
      throw new ConflictException({ code: 'PUBLISH_ELIGIBILITY_FAILED', message: `${account.platform} account is ${account.status}` });
    }
    return account;
  }

  private toDto(account: {
    id: string;
    platform: string;
    externalAccountId: string;
    displayName: string;
    username: string | null;
    avatarUrl: string | null;
    status: string;
    scopes: string[];
    tokenHealth: string;
    tokenCheckedAt: Date | null;
    publishingEnabled: boolean;
    publishingConfig: unknown;
    lastError: string | null;
    connectedAt: Date | null;
  }) {
    return {
      id: account.id,
      platform: account.platform,
      externalAccountId: account.externalAccountId,
      displayName: account.displayName,
      username: account.username,
      avatarUrl: account.avatarUrl,
      status: account.status,
      scopes: account.scopes,
      tokenHealth: account.tokenHealth,
      tokenCheckedAt: account.tokenCheckedAt?.toISOString() ?? null,
      publishingEnabled: account.publishingEnabled,
      publishingConfig: account.publishingConfig,
      lastError: account.lastError,
      connectedAt: account.connectedAt?.toISOString() ?? null,
      // Credentials are never serialised: only presence/expiry metadata.
    };
  }
}
