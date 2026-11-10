'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, uploadBrandAsset } from '@/lib/api';
import { useConfiguration, useIsOperator } from '@/lib/hooks';
import { Badge, Card, CardHeader, EmptyState, ErrorState, Field, Section, Skeleton, Toast } from '@/components/ui';

const VOICES = ['professional', 'educational', 'motivational', 'conversational', 'entertaining', 'custom'] as const;

export default function BrandPage() {
  const configuration = useConfiguration();
  // Brand assets and subtitle presets are OWNER/ADMIN only on the API: a member sees the existing
  // records but no create/upload controls.
  const isOperator = useIsOperator();
  const client = useQueryClient();
  const [open, setOpen] = useState<'brand' | 'preset'>('brand');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [brand, setBrand] = useState({
    name: '',
    brandVoice: 'educational',
    customVoiceInstructions: '',
    audienceDescription: '',
    primaryColor: '#14161A',
    secondaryColor: '#1F5AE0',
    textColor: '#FFFFFF',
    fontFamily: '',
    watermarkPosition: 'bottom-right',
    isDefault: false,
    logoStorageKey: null as string | null,
    introEnabled: false,
    outroEnabled: false,
    introAssetKey: null as string | null,
    outroAssetKey: null as string | null,
  });
  const [assetState, setAssetState] = useState<{ busy: string | null; error: string | null }>({ busy: null, error: null });
  const [preset, setPreset] = useState({
    name: '',
    fontFamily: 'Inter',
    fontSizePx: 64,
    fontWeight: 800,
    primaryColor: '#FFFFFF',
    highlightColor: '#FFE066',
    outlineColor: '#000000',
    outlineWidth: 4,
    shadow: 2,
    position: 'lower-third',
    safeMarginXPx: 80,
    safeMarginBottomPx: 320,
    backgroundOpacity: 0,
    uppercase: true,
    maxCharsPerLine: 22,
    maxLines: 2,
  });

  const uploadAsset = async (kind: 'LOGO' | 'INTRO' | 'OUTRO', file: File | undefined) => {
    if (!file) return;
    setAssetState({ busy: kind, error: null });
    try {
      const uploaded = await uploadBrandAsset(file, kind);
      if (kind === 'LOGO') setBrand((current) => ({ ...current, logoStorageKey: uploaded.storageKey }));
      if (kind === 'INTRO') setBrand((current) => ({ ...current, introEnabled: true, introAssetKey: uploaded.storageKey }));
      if (kind === 'OUTRO') setBrand((current) => ({ ...current, outroEnabled: true, outroAssetKey: uploaded.storageKey }));
      setAssetState({ busy: null, error: null });
      setMessage(`${kind} uploaded (${(uploaded.sizeBytes / 1024).toFixed(0)}KB) — save the profile to apply it.`);
    } catch (uploadError) {
      setAssetState({ busy: null, error: (uploadError as Error).message });
    }
  };

  const saveBrand = useMutation({
    mutationFn: () =>
      api('/api/brand-profiles', {
        method: 'POST',
        body: {
          ...brand,
          ...(brand.introEnabled && !brand.introAssetKey ? { introEnabled: false } : {}),
          ...(brand.outroEnabled && !brand.outroAssetKey ? { outroEnabled: false } : {}),
        },
      }),
    onSuccess: () => {
      setMessage('Brand profile created.');
      setError(null);
      void client.invalidateQueries({ queryKey: ['configuration'] });
    },
    onError: (mutationError: Error) => setError(mutationError.message),
  });

  const savePreset = useMutation({
    mutationFn: () => api('/api/subtitle-presets', { method: 'POST', body: { name: preset.name, style: { ...preset, name: undefined } } }),
    onSuccess: () => {
      setMessage('Subtitle preset created — select it under Settings → Subtitles.');
      setError(null);
      void client.invalidateQueries({ queryKey: ['configuration'] });
    },
    onError: (mutationError: Error) => setError(mutationError.message),
  });

  return (
    <div className="space-y-5">
      <Section
        as="h1" title="Brand studio" description="Brand profiles drive AI metadata tone; subtitle presets drive burned-in captions. Both are explicit workspace records — nothing is inferred." />

      {!isOperator ? (
        <Card className="px-5 py-4">
          <p className="text-[13px] font-semibold text-ink">Read-only view</p>
          <p className="mt-1 text-[13px] text-ink-soft">
            Brand profiles, subtitle presets and brand assets are managed by workspace owners and admins. You can see
            what is in use below; ask an owner to change it.
          </p>
        </Card>
      ) : null}

      <div className={`flex gap-1 rounded-lg bg-surface-sunken p-1 text-[13px] w-fit ${isOperator ? '' : 'hidden'}`}>
        {(['brand', 'preset'] as const).map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => setOpen(value)}
            className={`rounded-md px-3 py-1.5 font-medium transition ${open === value ? 'bg-white text-ink shadow-card' : 'text-ink-soft'}`}
          >
            {value === 'brand' ? 'Brand profile' : 'Subtitle preset'}
          </button>
        ))}
      </div>

      {error ? <ErrorState message={error} /> : null}
      {message ? <Toast tone="positive" onClose={() => setMessage(null)}>{message}</Toast> : null}

      {!isOperator && open === 'brand' ? null : open === 'brand' ? (
        <Card>
          <CardHeader title="New brand profile" description="The brand voice is injected into the per-platform metadata prompt" />
          <div className="grid gap-4 px-5 py-5 md:grid-cols-2">
            <Field label="Profile name" required><input className="input" value={brand.name} onChange={(event) => setBrand({ ...brand, name: event.target.value })} /></Field>
            <Field label="Brand voice" required>
              <select className="input" value={brand.brandVoice} onChange={(event) => setBrand({ ...brand, brandVoice: event.target.value })}>
                {VOICES.map((voice) => <option key={voice} value={voice}>{voice}</option>)}
              </select>
            </Field>
            <Field label="Custom voice instructions" hint="Required when voice is 'custom'.">
              <textarea className="input min-h-[64px]" value={brand.customVoiceInstructions} onChange={(event) => setBrand({ ...brand, customVoiceInstructions: event.target.value })} />
            </Field>
            <Field label="Audience description">
              <textarea className="input min-h-[64px]" value={brand.audienceDescription} onChange={(event) => setBrand({ ...brand, audienceDescription: event.target.value })} />
            </Field>
            <Field label="Primary colour" required><input className="input" value={brand.primaryColor} onChange={(event) => setBrand({ ...brand, primaryColor: event.target.value })} /></Field>
            <Field label="Secondary colour"><input className="input" value={brand.secondaryColor} onChange={(event) => setBrand({ ...brand, secondaryColor: event.target.value })} /></Field>
            <Field label="Text colour"><input className="input" value={brand.textColor} onChange={(event) => setBrand({ ...brand, textColor: event.target.value })} /></Field>
            <Field label="Font family" hint="Must be installed in the video processor image."><input className="input" value={brand.fontFamily} onChange={(event) => setBrand({ ...brand, fontFamily: event.target.value })} /></Field>
            <Field label="Watermark position" required>
              <select className="input" value={brand.watermarkPosition} onChange={(event) => setBrand({ ...brand, watermarkPosition: event.target.value })}>
                {['top-left', 'top-right', 'bottom-left', 'bottom-right'].map((position) => <option key={position} value={position}>{position}</option>)}
              </select>
            </Field>
            <Field label="Logo / watermark (PNG, JPEG or WebP ≤ 8MB)" hint={brand.logoStorageKey ? `Stored as ${brand.logoStorageKey.split('/').pop()}` : 'Burned in at the watermark position you choose above.'}>
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="input !py-1.5 text-xs"
                onChange={(event) => void uploadAsset('LOGO', event.target.files?.[0])}
              />
            </Field>
            <Field label="Intro video (MP4 ≤ 64MB)" hint={brand.introAssetKey ? `Stored as ${brand.introAssetKey.split('/').pop()}` : 'Prepended before the clip. Enable only when you want it.'}>
              <input
                type="file"
                accept="video/mp4"
                className="input !py-1.5 text-xs"
                onChange={(event) => void uploadAsset('INTRO', event.target.files?.[0])}
              />
            </Field>
            <Field label="Outro video (MP4 ≤ 64MB)" hint={brand.outroAssetKey ? `Stored as ${brand.outroAssetKey.split('/').pop()}` : 'Appended after the clip.'}>
              <input
                type="file"
                accept="video/mp4"
                className="input !py-1.5 text-xs"
                onChange={(event) => void uploadAsset('OUTRO', event.target.files?.[0])}
              />
            </Field>
            <label className="flex items-center gap-2 self-end text-[13px] text-ink-soft">
              <input type="checkbox" checked={brand.isDefault} onChange={(event) => setBrand({ ...brand, isDefault: event.target.checked })} />
              Make this the default profile
            </label>
            {assetState.busy ? <p className="self-end text-xs text-ink-faint">Uploading {assetState.busy}…</p> : null}
            {assetState.error ? <p className="self-end text-xs text-danger">{assetState.error}</p> : null}
          </div>
          <div className="border-t border-line px-5 py-3">
            <button type="button" className="btn-primary" onClick={() => saveBrand.mutate()} disabled={!brand.name || saveBrand.isPending}>
              {saveBrand.isPending ? 'Saving…' : 'Create brand profile'}
            </button>
          </div>
        </Card>
      ) : !isOperator && open === 'preset' ? null : open === 'preset' ? (
        <Card>
          <CardHeader title="New subtitle preset" description="Word-level highlighting is applied at the times Whisper reported — never estimated" />
          <div className="grid gap-4 px-5 py-5 md:grid-cols-3">
            <Field label="Preset name" required><input className="input" value={preset.name} onChange={(event) => setPreset({ ...preset, name: event.target.value })} /></Field>
            <Field label="Font family" required><input className="input" value={preset.fontFamily} onChange={(event) => setPreset({ ...preset, fontFamily: event.target.value })} /></Field>
            <Field label="Font size (px)" required><input type="number" className="input" value={preset.fontSizePx} onChange={(event) => setPreset({ ...preset, fontSizePx: Number(event.target.value) })} /></Field>
            <Field label="Font weight"><input type="number" className="input" value={preset.fontWeight} onChange={(event) => setPreset({ ...preset, fontWeight: Number(event.target.value) })} /></Field>
            <Field label="Text colour"><input className="input" value={preset.primaryColor} onChange={(event) => setPreset({ ...preset, primaryColor: event.target.value })} /></Field>
            <Field label="Highlight colour"><input className="input" value={preset.highlightColor} onChange={(event) => setPreset({ ...preset, highlightColor: event.target.value })} /></Field>
            <Field label="Outline colour"><input className="input" value={preset.outlineColor} onChange={(event) => setPreset({ ...preset, outlineColor: event.target.value })} /></Field>
            <Field label="Outline width"><input type="number" step="0.5" className="input" value={preset.outlineWidth} onChange={(event) => setPreset({ ...preset, outlineWidth: Number(event.target.value) })} /></Field>
            <Field label="Shadow"><input type="number" step="0.5" className="input" value={preset.shadow} onChange={(event) => setPreset({ ...preset, shadow: Number(event.target.value) })} /></Field>
            <Field label="Position">
              <select className="input" value={preset.position} onChange={(event) => setPreset({ ...preset, position: event.target.value })}>
                {['lower-third', 'middle', 'upper-third'].map((position) => <option key={position} value={position}>{position}</option>)}
              </select>
            </Field>
            <Field label="Safe margin X (px)"><input type="number" className="input" value={preset.safeMarginXPx} onChange={(event) => setPreset({ ...preset, safeMarginXPx: Number(event.target.value) })} /></Field>
            <Field label="Safe margin bottom (px)"><input type="number" className="input" value={preset.safeMarginBottomPx} onChange={(event) => setPreset({ ...preset, safeMarginBottomPx: Number(event.target.value) })} /></Field>
            <Field label="Max characters per line"><input type="number" className="input" value={preset.maxCharsPerLine} onChange={(event) => setPreset({ ...preset, maxCharsPerLine: Number(event.target.value) })} /></Field>
            <Field label="Max lines"><input type="number" className="input" value={preset.maxLines} onChange={(event) => setPreset({ ...preset, maxLines: Number(event.target.value) })} /></Field>
            <Field label="Background opacity (0–1)"><input type="number" step="0.05" className="input" value={preset.backgroundOpacity} onChange={(event) => setPreset({ ...preset, backgroundOpacity: Number(event.target.value) })} /></Field>
            <label className="flex items-center gap-2 self-end text-[13px] text-ink-soft">
              <input type="checkbox" checked={preset.uppercase} onChange={(event) => setPreset({ ...preset, uppercase: event.target.checked })} />
              Uppercase captions
            </label>
          </div>
          <div className="border-t border-line px-5 py-3">
            <button type="button" className="btn-primary" onClick={() => savePreset.mutate()} disabled={!preset.name || savePreset.isPending}>
              {savePreset.isPending ? 'Saving…' : 'Create subtitle preset'}
            </button>
          </div>
        </Card>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader title="Brand profiles" />
          {configuration.isLoading ? <Skeleton rows={2} /> : configuration.data!.brandProfiles.length === 0 ? (
            <EmptyState title="No brand profiles" description="Create one above so AI metadata matches your voice." />
          ) : (
            <ul className="divide-y divide-line">
              {configuration.data!.brandProfiles.map((profile) => (
                <li key={profile.id} className="px-5 py-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-medium text-ink">{profile.name}</p>
                    <span className="flex gap-2">
                      {profile.isDefault ? <Badge tone="accent">default</Badge> : null}
                      <Badge tone="neutral">{profile.brandVoice ?? '—'}</Badge>
                    </span>
                  </div>
                  <p className="mt-0.5 text-xs text-ink-faint">{profile.audienceDescription ?? 'No audience description'}</p>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card>
          <CardHeader title="Subtitle presets" />
          {configuration.isLoading ? <Skeleton rows={2} /> : (
            <ul className="divide-y divide-line">
              {configuration.data!.subtitlePresets.map((item) => (
                <li key={item.id} className="flex items-center justify-between gap-2 px-5 py-3">
                  <div>
                    <p className="text-sm font-medium text-ink">{item.name}</p>
                    <p className="text-xs text-ink-faint">
                      {String((item.style as Record<string, unknown>).fontFamily ?? '')} · {String((item.style as Record<string, unknown>).fontSizePx ?? '')}px · {String((item.style as Record<string, unknown>).position ?? '')}
                    </p>
                  </div>
                  {item.isSystem ? <Badge tone="neutral">system</Badge> : <Badge tone="accent">custom</Badge>}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
