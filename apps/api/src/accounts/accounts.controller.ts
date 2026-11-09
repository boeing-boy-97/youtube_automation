import { Body, Controller, Delete, Get, Param, Post, Query, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';
import { CurrentContext, Public } from '../common/decorators/auth.decorators';
import type { RequestContext } from '../common/guards/session-auth.guard';
import { RateLimit } from '../common/decorators/rate-limit.decorator';
import { env } from '../common/env';
import { AccountsService } from './accounts.service';

const selectChannelSchema = z.object({ pendingToken: z.string().min(16), channelId: z.string().min(3).max(64) });

@ApiTags('accounts')
@Controller('api/accounts')
export class AccountsController {
  constructor(private readonly accounts: AccountsService) {}

  @Get()
  @ApiOperation({ summary: 'List connected accounts (no credentials are ever returned)' })
  list(@CurrentContext() ctx: RequestContext) {
    return this.accounts.list(ctx);
  }

  @Post('youtube/connect')
  @RateLimit({ limit: 10, windowSeconds: 60, scope: 'account-connect' })
  startYouTube(@CurrentContext() ctx: RequestContext) {
    return this.accounts.startYouTube(ctx);
  }

  @Get('youtube/callback')
  @Public()
  @ApiOperation({ summary: 'YouTube OAuth callback — verifies state, returns channels for explicit selection' })
  async youtubeCallback(@Query('code') code: string, @Query('state') state: string, @Query('error') error: string | undefined, @Res() res: Response) {
    if (error) return res.redirect(`${env.APP_URL}/accounts?oauth=error&reason=${encodeURIComponent(error)}`);
    if (!code || !state) return res.redirect(`${env.APP_URL}/accounts?oauth=error&reason=missing_code_or_state`);
    try {
      const result = await this.accounts.handleYouTubeCallback(code, state);
      const encoded = Buffer.from(JSON.stringify(result.channels)).toString('base64url');
      return res.redirect(`${env.APP_URL}/accounts?oauth=youtube_select&pending=${result.pendingToken}&channels=${encoded}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'callback failed';
      return res.redirect(`${env.APP_URL}/accounts?oauth=error&reason=${encodeURIComponent(message)}`);
    }
  }

  @Post('youtube/select-channel')
  @ApiOperation({ summary: 'Confirm which authorized YouTube channel to publish to' })
  selectChannel(@Body() body: unknown, @CurrentContext() ctx: RequestContext) {
    const parsed = selectChannelSchema.parse(body);
    return this.accounts.completeYouTubeSelection(parsed.pendingToken, parsed.channelId, ctx);
  }

  @Post('instagram/connect')
  @RateLimit({ limit: 10, windowSeconds: 60, scope: 'account-connect' })
  startInstagram(@CurrentContext() ctx: RequestContext) {
    return this.accounts.startInstagram(ctx);
  }

  @Get('instagram/callback')
  @Public()
  @ApiOperation({ summary: 'Instagram OAuth callback (Instagram API with Instagram Login)' })
  async instagramCallback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Query('error') error: string | undefined,
    @Query('error_description') description: string | undefined,
    @Res() res: Response,
  ) {
    if (error) return res.redirect(`${env.APP_URL}/accounts?oauth=error&reason=${encodeURIComponent(description ?? error)}`);
    if (!code || !state) return res.redirect(`${env.APP_URL}/accounts?oauth=error&reason=missing_code_or_state`);
    try {
      const account = await this.accounts.handleInstagramCallback(code, state);
      return res.redirect(`${env.APP_URL}/accounts?oauth=instagram_connected&account=${account.id}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'callback failed';
      return res.redirect(`${env.APP_URL}/accounts?oauth=error&reason=${encodeURIComponent(message)}`);
    }
  }

  @Post(':id/verify')
  @RateLimit({ limit: 30, windowSeconds: 60, scope: 'account-verify' })
  verify(@Param('id') id: string, @CurrentContext() ctx: RequestContext) {
    return this.accounts.verify(id, ctx);
  }

  @Delete(':id')
  disconnect(@Param('id') id: string, @CurrentContext() ctx: RequestContext) {
    return this.accounts.disconnect(id, ctx);
  }
}
