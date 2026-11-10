'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense, useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAccounts, useDisconnectAccount, useIsOperator, useVerifyAccount } from '@/lib/hooks';
import { Badge, Card, CardHeader, EmptyState, ErrorState, Field, Section, Skeleton, StatusBadge } from '@/components/ui';

interface YouTubeChannel { id: string; title: string; handle: string | null; thumbnail: string | null }

export default function AccountsPage() {
  return (
    <Suspense fallback={<Card><Skeleton rows={4} /></Card>}>
      <AccountsContent />
    </Suspense>
  );
}

function AccountsContent() {
  const params = useSearchParams();
  const client = useQueryClient();
  const accounts = useAccounts();
  const verify = useVerifyAccount();
  const disconnect = useDisconnectAccount();
  // OAuth connect/disconnect/verify are OWNER/ADMIN only on the API.
  const isOperator = useIsOperator();
  const [notice, setNotice] = useState<string | null>(null);

  const oauth = params.get('oauth');
  const reason = params.get('reason');
  const pendingToken = params.get('pending');
  const channels = useMemo<YouTubeChannel[]>(() => {
    const encoded = params.get('channels');
    if (!encoded) return [];
    try {
      const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
      return JSON.parse(decodeURIComponent(escape(atob(base64)))) as YouTubeChannel[];
    } catch {
      return [];
    }
  }, [params]);

  const connectYouTube = useMutation({
    mutationFn: () => api<{ authorizationUrl: string }>('/api/accounts/youtube/connect', { method: 'POST', body: {} }),
    onSuccess: (data) => {
      window.location.href = data.authorizationUrl;
    },
    onError: (error: Error) => setNotice(error.message),
  });
  const connectInstagram = useMutation({
    mutationFn: () => api<{ authorizationUrl: string }>('/api/accounts/instagram/connect', { method: 'POST', body: {} }),
    onSuccess: (data) => {
      window.location.href = data.authorizationUrl;
    },
    onError: (error: Error) => setNotice(error.message),
  });
  const selectChannel = useMutation({
    mutationFn: (channelId: string) =>
      api('/api/accounts/youtube/select-channel', { method: 'POST', body: { pendingToken, channelId } }),
    onSuccess: () => {
      setNotice('YouTube channel connected. Enable publishing below to authorise automatic uploads.');
      void client.invalidateQueries();
    },
    onError: (error: Error) => setNotice(error.message),
  });

  const integrations = accounts.data?.integrations;

  return (
    <div className="space-y-5">
      <Section
        as="h1" title="Connected accounts" description="OAuth tokens are encrypted at rest with AES-256-GCM and never returned to the browser." />

      {oauth === 'error' ? <ErrorState message={`Authorization failed: ${reason ?? 'unknown error'}`} /> : null}
      {notice ? <ErrorState message={notice} /> : null}

      {oauth === 'youtube_select' && pendingToken && channels.length > 0 ? (
        <Card>
          <CardHeader title="Choose the channel to publish to" description="ClipForge never guesses — you must select the exact channel explicitly." />
          <ul className="divide-y divide-line">
            {channels.map((channel) => (
              <li key={channel.id} className="flex items-center justify-between gap-3 px-5 py-3">
                <div>
                  <p className="text-sm font-medium text-ink">{channel.title}</p>
                  <p className="text-xs text-ink-faint">{channel.handle ?? channel.id}</p>
                </div>
                <button type="button" className="btn-primary !px-3 !py-1.5 text-[13px]" onClick={() => selectChannel.mutate(channel.id)} disabled={selectChannel.isPending}>
                  Use this channel
                </button>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2">
        <Card className="px-5 py-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-ink">YouTube Shorts</p>
              <p className="mt-0.5 text-[13px] text-ink-soft">YouTube Data API v3 · resumable uploads</p>
            </div>
            <Badge tone={integrations?.youtubeConfigured ? 'positive' : 'caution'}>
              {integrations?.youtubeConfigured ? 'app configured' : 'awaiting credentials'}
            </Badge>
          </div>
          <p className="mt-3 text-xs text-ink-faint">
            {integrations?.youtubeConfigured
              ? 'OAuth client credentials are present. Connect a channel to authorise uploads.'
              : 'Set YOUTUBE_CLIENT_ID / YOUTUBE_CLIENT_SECRET in the API environment, then restart the API.'}
          </p>
          <button type="button" className="btn-secondary mt-3" onClick={() => connectYouTube.mutate()} disabled={!isOperator || !integrations?.youtubeConfigured || connectYouTube.isPending}>
            {isOperator ? 'Connect YouTube channel' : 'Owners and admins connect channels'}
          </button>
        </Card>

        <Card className="px-5 py-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-ink">Instagram Reels</p>
              <p className="mt-0.5 text-[13px] text-ink-soft">
                Instagram Graph API {integrations?.graphApiVersion ?? '—'} · Reels container publishing
              </p>
            </div>
            <Badge tone={integrations?.instagramConfigured ? 'positive' : 'caution'}>
              {integrations?.instagramConfigured ? 'app configured' : 'awaiting credentials'}
            </Badge>
          </div>
          <p className="mt-3 text-xs text-ink-faint">
            {integrations?.instagramConfigured
              ? 'Meta app credentials are present. Connect the Instagram professional account.'
              : 'Set INSTAGRAM_APP_ID / INSTAGRAM_APP_SECRET and META_GRAPH_API_VERSION in the API environment.'}
          </p>
          <button type="button" className="btn-secondary mt-3" onClick={() => connectInstagram.mutate()} disabled={!isOperator || !integrations?.instagramConfigured || connectInstagram.isPending}>
            Connect Instagram account
          </button>
        </Card>
      </div>

      <Card>
        <CardHeader title="Authorised accounts" description="Enable publishing per account with an explicit privacy/visibility setting" />
        {accounts.isLoading ? (
          <Skeleton rows={3} />
        ) : accounts.error ? (
          <div className="p-5"><ErrorState message={accounts.error.message} onRetry={() => void accounts.refetch()} /></div>
        ) : accounts.data!.accounts.length === 0 ? (
          <EmptyState title="No accounts connected" description="Connect a YouTube channel or Instagram professional account above. Publishing stays disabled until you enable it per account." />
        ) : (
          <ul className="divide-y divide-line">
            {accounts.data!.accounts.map((account) => (
              <li key={account.id} className="px-5 py-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium text-ink">{account.displayName}</p>
                    <p className="text-xs text-ink-faint">
                      {account.platform} · {account.username ?? account.externalAccountId} · token {account.tokenHealth.toLowerCase()}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <StatusBadge value={account.status} />
                    <Badge tone={account.publishingEnabled ? 'positive' : 'neutral'}>{account.publishingEnabled ? 'publishing on' : 'publishing off'}</Badge>
                  </div>
                </div>
                {account.lastError ? <p className="mt-2 text-xs text-danger">{account.lastError}</p> : null}
                <div className="mt-3 flex gap-2">
                  <button type="button" className="btn-secondary !px-3 !py-1.5 text-xs" onClick={() => verify.mutate(account.id)} disabled={verify.isPending}>
                    Verify access
                  </button>
                  <button
                    type="button"
                    className="btn-ghost !px-3 !py-1.5 text-xs text-danger"
                    onClick={() => {
                      if (window.confirm(`Disconnect ${account.displayName}? Existing published posts are unaffected.`)) disconnect.mutate(account.id);
                    }}
                  >
                    Disconnect
                  </button>
                </div>
                <PublishingToggle account={account} />
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function PublishingToggle({ account }: { account: { id: string; platform: 'YOUTUBE' | 'INSTAGRAM'; publishingEnabled: boolean } }) {
  const client = useQueryClient();
  const [visibility, setVisibility] = useState('UNLISTED');
  const [categoryId, setCategoryId] = useState('24');
  const [madeForKids, setMadeForKids] = useState(false);
  const [shareToFeed, setShareToFeed] = useState(true);
  const [language, setLanguage] = useState('en');
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = useMutation({
    mutationFn: (enabled: boolean) =>
      api(`/api/publishing/${enabled ? 'enable' : 'disable'}`, {
        method: 'POST',
        body: {
          platform: account.platform,
          connectedAccountId: account.id,
          enabled,
          termsAccepted: true,
          ...(account.platform === 'YOUTUBE'
            ? { youtube: { visibility, categoryId, madeForKids, defaultLanguage: language } }
            : { instagram: { shareToFeed, defaultLanguage: language } }),
        },
      }),
    onSuccess: () => {
      setError(null);
      void client.invalidateQueries({ queryKey: ['accounts'] });
    },
    onError: (mutationError: Error) => setError(mutationError.message),
  });

  if (account.publishingEnabled) {
    return (
      <div className="mt-3 flex items-center gap-2">
        <button type="button" className="btn-ghost !px-3 !py-1.5 text-xs" onClick={() => toggle.mutate(false)} disabled={toggle.isPending}>
          Disable automatic publishing
        </button>
        {error ? <span className="text-xs text-danger">{error}</span> : null}
      </div>
    );
  }

  return (
    <div className="mt-3 rounded-xl2 border border-line bg-surface-muted p-3">
      <p className="text-xs font-medium text-ink">Enable automatic publishing</p>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        {account.platform === 'YOUTUBE' ? (
          <>
            <Field label="Visibility" required>
              <select className="input !py-1.5 text-xs" value={visibility} onChange={(event) => setVisibility(event.target.value)}>
                <option value="UNLISTED">Unlisted</option>
                <option value="PUBLIC">Public</option>
                <option value="PRIVATE">Private</option>
              </select>
            </Field>
            <Field label="Category id" required>
              <input className="input !py-1.5 text-xs" value={categoryId} onChange={(event) => setCategoryId(event.target.value)} />
            </Field>
            <label className="flex items-center gap-2 text-xs text-ink-soft">
              <input type="checkbox" checked={madeForKids} onChange={(event) => setMadeForKids(event.target.checked)} />
              Made for kids
            </label>
          </>
        ) : (
          <label className="flex items-center gap-2 text-xs text-ink-soft">
            <input type="checkbox" checked={shareToFeed} onChange={(event) => setShareToFeed(event.target.checked)} />
            Also share to feed
          </label>
        )}
        <Field label="Default language" required>
          <input className="input !py-1.5 text-xs" value={language} onChange={(event) => setLanguage(event.target.value)} />
        </Field>
      </div>
      <label className="mt-2 flex items-start gap-2 text-xs text-ink-soft">
        <input type="checkbox" className="mt-0.5" checked={termsAccepted} onChange={(event) => setTermsAccepted(event.target.checked)} />
        I confirm I have the rights to publish these clips and I accept the platform's terms.
      </label>
      {error ? <p className="mt-1 text-xs text-danger">{error}</p> : null}
      <button type="button" className="btn-primary mt-2 !px-3 !py-1.5 text-xs" disabled={!termsAccepted || toggle.isPending} onClick={() => toggle.mutate(true)}>
        {toggle.isPending ? 'Enabling…' : 'Enable publishing'}
      </button>
    </div>
  );
}
