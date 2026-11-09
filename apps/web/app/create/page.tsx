'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, uploadSource } from '@/lib/api';
import { useConfiguration, useSession } from '@/lib/hooks';
import { Card, CardHeader, ErrorState, Field, Section } from '@/components/ui';

const RIGHTS = [
  { value: 'I_OWN_THE_CONTENT', label: 'I own this content' },
  { value: 'I_HAVE_WRITTEN_PERMISSION', label: 'I have written permission from the rights holder' },
  { value: 'LICENSED_FOR_REPURPOSING', label: 'I hold a licence that permits repurposing' },
];

export default function CreatePage() {
  const router = useRouter();
  const client = useQueryClient();
  const session = useSession();
  const configuration = useConfiguration();
  const [file, setFile] = useState<File | null>(null);
  const [uploadPercent, setUploadPercent] = useState(0);
  const [rights, setRights] = useState('');
  const [rightsNote, setRightsNote] = useState('');
  const [youtubeReference, setYoutubeReference] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');
  const [error, setError] = useState<string | null>(null);

  const missing = configuration.data?.missingForProcessing ?? session.data?.configuration?.missing ?? [];

  const createFromFile = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error('Select a video file first');
      if (!rights) throw new Error('A rights declaration is mandatory');
      const source = await uploadSource(file, {
        rightsStatement: `${rights}${rightsNote ? ` — ${rightsNote}` : ''}`,
        youTubeReferenceUrl: youtubeReference || undefined,
        onProgress: (progress) => setUploadPercent(progress.percent),
      });
      return api<{ id: string }>('/api/jobs', { method: 'POST', body: { sourceId: source.id } });
    },
    onSuccess: (job) => {
      void client.invalidateQueries({ queryKey: ['jobs'] });
      setUploadPercent(0);
      router.push(`/jobs/${job.id}`);
    },
    onError: (mutationError: Error) => {
      setUploadPercent(0);
      setError(mutationError.message);
    },
  });

  const importFromUrl = useMutation({
    mutationFn: async () => {
      if (!rights) throw new Error('A rights declaration is mandatory');
      const source = await api<{ id: string; sourceVideoId?: string }>('/api/sources/import', {
        method: 'POST',
        body: {
          url: sourceUrl,
          rightsDeclaration: { accepted: true, statement: `${rights}${rightsNote ? ` — ${rightsNote}` : ''}` },
          youTubeReferenceUrl: youtubeReference || undefined,
        },
      });
      return api<{ id: string }>('/api/jobs', { method: 'POST', body: { sourceId: source.sourceVideoId ?? source.id } });
    },
    onSuccess: (job) => router.push(`/jobs/${job.id}`),
    onError: (mutationError: Error) => setError(mutationError.message),
  });

  return (
    <div className="space-y-6">
      <Section title="Create a project" description="Upload original media or import an authorised direct URL. Every upload is validated with FFprobe before processing starts." />

      {missing.length > 0 ? (
        <ErrorState
          code="CONFIGURATION_REQUIRED"
          message="Configuration required — processing cannot start."
          missing={missing}
        />
      ) : null}

      {error ? <ErrorState message={error} /> : null}

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader title="Upload a video file" description="MP4/MOV/WebM · validated mime, signature, duration, resolution and codecs" />
          <div className="space-y-4 px-5 py-5">
            <label className="flex cursor-pointer flex-col items-center justify-center rounded-xl2 border border-dashed border-line bg-surface-muted px-5 py-10 text-center hover:border-accent/50">
              <span className="text-sm font-medium text-ink">{file ? file.name : 'Choose a video file'}</span>
              <span className="mt-1 text-xs text-ink-faint">
                {file ? `${(file.size / 1024 / 1024).toFixed(1)} MB selected` : 'Click to browse — nothing is uploaded until you submit'}
              </span>
              <input
                type="file"
                accept="video/*"
                className="sr-only"
                onChange={(event) => {
                  setFile(event.target.files?.[0] ?? null);
                  setError(null);
                }}
              />
            </label>
            {uploadPercent > 0 && uploadPercent < 100 ? (
              <p className="text-xs text-ink-soft">Uploading… {uploadPercent}%</p>
            ) : null}
            <button
              type="button"
              className="btn-primary w-full"
              disabled={!file || !rights || missing.length > 0 || createFromFile.isPending}
              onClick={() => {
                setError(null);
                createFromFile.mutate();
              }}
            >
              {createFromFile.isPending ? 'Uploading and queueing…' : 'Upload and start processing'}
            </button>
          </div>
        </Card>

        <Card>
          <CardHeader title="Import from a direct URL" description="Public HTTPS MP4/WebM only. Private ranges and redirects to internal hosts are blocked (SSRF protection)." />
          <div className="space-y-4 px-5 py-5">
            <Field label="Direct media URL" required>
              <input className="input" placeholder="https://cdn.example.com/episode-12.mp4" value={sourceUrl} onChange={(event) => setSourceUrl(event.target.value)} />
            </Field>
            <button
              type="button"
              className="btn-secondary w-full"
              disabled={!sourceUrl || !rights || missing.length > 0 || importFromUrl.isPending}
              onClick={() => {
                setError(null);
                importFromUrl.mutate();
              }}
            >
              {importFromUrl.isPending ? 'Importing…' : 'Import and start processing'}
            </button>
            <p className="hint">YouTube links are stored as reference metadata only — ClipForge never downloads or scrapes YouTube media.</p>
          </div>
        </Card>
      </div>

      <Card>
        <CardHeader title="Rights and processing settings" description="A rights declaration is mandatory for every source, and settings are read from your saved configuration — never silently defaulted." />
        <div className="space-y-4 px-5 py-5">
          <Field label="Rights declaration" required>
            <select className="input" value={rights} onChange={(event) => setRights(event.target.value)}>
              <option value="">Select a declaration…</option>
              {RIGHTS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Rights note" hint="Optional context stored with the audit trail (licence id, client name, contract reference).">
            <textarea className="input min-h-[72px]" value={rightsNote} onChange={(event) => setRightsNote(event.target.value)} />
          </Field>
          <Field label="YouTube reference URL" hint="Reference only — used for attribution and never fetched.">
            <input className="input" placeholder="https://www.youtube.com/watch?v=…" value={youtubeReference} onChange={(event) => setYoutubeReference(event.target.value)} />
          </Field>
          <div className="rounded-xl2 border border-line bg-surface-muted px-4 py-3 text-[13px] text-ink-soft">
            <p className="font-medium text-ink">Active processing configuration</p>
            <p className="mt-1">
              {configuration.data
                ? `Render ${String((configuration.data.values['render.output_width'] as number) ?? '—')}×${String((configuration.data.values['render.output_height'] as number) ?? '—')} @ ${String((configuration.data.values['render.fps'] as number) ?? '—')} fps · framing ${String(configuration.data.values['render.framing_mode'] ?? '—')} · subtitles ${String(configuration.data.values['subtitles.preset_id'] ?? '—')}`
                : 'Loading configuration…'}
            </p>
          </div>
        </div>
      </Card>
    </div>
  );
}
