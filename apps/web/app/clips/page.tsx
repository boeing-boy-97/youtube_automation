'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useClip, useClips, usePublishing } from '@/lib/hooks';
import { Badge, Card, CardHeader, EmptyState, ErrorState, Field, Section, Skeleton, StatusBadge } from '@/components/ui';

export default function ClipsPage() {
  const [durationFilter, setDurationFilter] = useState<number | undefined>(undefined);
  const [selected, setSelected] = useState<string | null>(null);
  const clips = useClips({ durationKind: durationFilter });
  const detail = useClip(selected);

  return (
    <div className="space-y-5">
      <Section
        title="Clip library"
        description="Clips selected by the AI pipeline. Only clips that scored above your configured threshold exist here."
        action={
          <div className="flex gap-1 rounded-lg bg-surface-sunken p-1 text-[13px]">
            {[undefined, 15, 30].map((value) => (
              <button
                key={String(value)}
                type="button"
                onClick={() => setDurationFilter(value)}
                className={`rounded-md px-3 py-1.5 font-medium transition ${durationFilter === value ? 'bg-white text-ink shadow-card' : 'text-ink-soft'}`}
              >
                {value ? `${value}s` : 'All'}
              </button>
            ))}
          </div>
        }
      />

      <div className="grid gap-5 lg:grid-cols-[1.15fr_1fr]">
        <Card>
          <CardHeader title={clips.data ? `${clips.data.total} clip(s)` : 'Loading clips'} description="Sorted by quality score" />
          {clips.isLoading ? (
            <Skeleton rows={4} />
          ) : clips.error ? (
            <div className="p-5"><ErrorState message={clips.error.message} onRetry={() => void clips.refetch()} /></div>
          ) : clips.data!.items.length === 0 ? (
            <EmptyState title="No clips match this filter" description="Run a project first, or clear the duration filter." action={<Link href="/create" className="btn-primary">Create project</Link>} />
          ) : (
            <ul className="divide-y divide-line">
              {clips.data!.items.map((clip) => (
                <li key={clip.id}>
                  <button
                    type="button"
                    onClick={() => setSelected(clip.id)}
                    className={`w-full px-5 py-3.5 text-left transition hover:bg-surface-muted ${selected === clip.id ? 'bg-accent-soft/50' : ''}`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-ink">{clip.title || 'Untitled clip'}</p>
                        <p className="mt-0.5 text-xs text-ink-faint">
                          {clip.durationKind}s · {clip.startSeconds.toFixed(1)}–{clip.endSeconds.toFixed(1)}s · {clip.contentCategory}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <Badge tone={clip.qualityScore >= 75 ? 'positive' : clip.qualityScore >= 60 ? 'caution' : 'neutral'}>{clip.qualityScore}</Badge>
                        <StatusBadge value={clip.status} />
                      </div>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader title="Clip detail" description="Preview, metadata and publishing state" />
          {!selected ? (
            <EmptyState title="Select a clip" description="Choose a clip on the left to inspect its AI rationale, rendered variants and platform metadata." />
          ) : detail.isLoading ? (
            <Skeleton rows={6} />
          ) : detail.error ? (
            <div className="p-5"><ErrorState message={detail.error.message} onRetry={() => void detail.refetch()} /></div>
          ) : (
            <div className="space-y-4 px-5 py-4">
              <div>
                <h3 className="text-sm font-semibold text-ink">{detail.data!.title}</h3>
                <p className="mt-0.5 text-xs text-ink-faint">
                  {detail.data!.durationKind}s variant · score {detail.data!.qualityScore}/100 · {detail.data!.contentCategory}
                </p>
              </div>
              {detail.data!.variants.map((variant) => (
                <div key={variant.id} className="rounded-xl2 border border-line bg-surface-muted p-3">
                  {variant.previewUrl ? (
                    <video src={variant.previewUrl} controls playsInline className="mb-2 aspect-[9/16] w-full max-w-[210px] rounded-lg bg-black" />
                  ) : (
                    <p className="mb-2 text-xs text-ink-soft">No rendered file available yet.</p>
                  )}
                  <p className="text-xs text-ink-soft">
                    {variant.width}×{variant.height} · {variant.fps} fps · {variant.durationSeconds?.toFixed(2) ?? '—'}s
                  </p>
                  <div className="mt-2 flex gap-2">
                    <a href={variant.downloadUrl ?? '#'} className="btn-secondary !px-3 !py-1 text-xs" download>
                      Download MP4
                    </a>
                  </div>
                </div>
              ))}
              {detail.data!.candidate ? (
                <div className="space-y-2 text-[13px]">
                  <p className="font-medium text-ink">Why this clip</p>
                  <p className="text-ink-soft">{detail.data!.candidate.reason}</p>
                  <p className="font-medium text-ink">Hook</p>
                  <p className="text-ink-soft">{detail.data!.candidate.hook}</p>
                  {detail.data!.candidate.visualContext ? (
                    <>
                      <p className="font-medium text-ink">Visual context</p>
                      <p className="text-ink-soft">{detail.data!.candidate.visualContext}</p>
                    </>
                  ) : null}
                  <p className="font-medium text-ink">Transcript</p>
                  <p className="max-h-32 overflow-auto rounded-lg bg-surface-muted p-2 text-ink-soft">{detail.data!.candidate.transcript}</p>
                  <p className="text-xs text-ink-faint">Confidence {(detail.data!.candidate.confidence * 100).toFixed(0)}%</p>
                </div>
              ) : null}
              {detail.data!.metadata.length > 0 ? (
                <div className="space-y-2">
                  <p className="text-[13px] font-medium text-ink">Platform metadata</p>
                  {detail.data!.metadata.map((meta) => (
                    <MetadataEditor key={meta.platform} clipId={detail.data!.id} meta={meta} />
                  ))}
                </div>
              ) : null}
              {detail.data!.publishing.length > 0 ? (
                <div className="space-y-1 text-[13px]">
                  <p className="font-medium text-ink">Publishing</p>
                  {detail.data!.publishing.map((record) => (
                    <div key={record.id} className="flex items-center justify-between gap-2">
                      <span className="text-ink-soft">{record.platform} → {record.account}</span>
                      <span className="flex items-center gap-2">
                        {record.externalUrl ? <a className="text-accent hover:underline" href={record.externalUrl} target="_blank" rel="noreferrer">Open</a> : null}
                        <StatusBadge value={record.status} />
                      </span>
                    </div>
                  ))}
                </div>
              ) : null}
              <PublishPanel clipId={detail.data!.id} platforms={detail.data!.variants.length > 0} />
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

/**
 * Per-platform metadata is editable before publishing — the API has supported PATCH since the
 * start, so a read-only panel left a required workflow unreachable.
 */
function MetadataEditor({
  clipId,
  meta,
}: {
  clipId: string;
  meta: { platform: string; title: string | null; description: string | null; hashtags: string[]; tags: string[]; reviewStatus: string };
}) {
  const client = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(meta.title ?? '');
  const [description, setDescription] = useState(meta.description ?? '');
  const [hashtags, setHashtags] = useState(meta.hashtags.join(' '));
  const [tags, setTags] = useState(meta.tags.join(', '));
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () =>
      api(`/api/clips/${clipId}/metadata`, {
        method: 'PATCH',
        body: {
          platform: meta.platform,
          title,
          description,
          hashtags: hashtags.split(/[\s,]+/).map((value) => value.trim()).filter(Boolean),
          tags: tags.split(',').map((value) => value.trim()).filter(Boolean),
        },
      }),
    onSuccess: () => {
      setError(null);
      setEditing(false);
      void client.invalidateQueries({ queryKey: ['clip', clipId] });
      void client.invalidateQueries({ queryKey: ['clips'] });
    },
    onError: (mutationError: Error) => setError(mutationError.message),
  });

  return (
    <div className="rounded-xl2 border border-line p-3 text-[13px]">
      <div className="flex items-center justify-between">
        <span className="font-medium text-ink">{meta.platform}</span>
        <span className="flex items-center gap-2">
          <StatusBadge value={meta.reviewStatus} />
          <button type="button" className="text-xs font-medium text-accent hover:underline" onClick={() => setEditing((value) => !value)}>
            {editing ? 'Cancel' : 'Edit'}
          </button>
        </span>
      </div>
      {!editing ? (
        <>
          <p className="mt-1 font-medium text-ink">{meta.title}</p>
          <p className="mt-1 whitespace-pre-wrap text-ink-soft">{meta.description}</p>
          {meta.hashtags.length > 0 ? <p className="mt-1 text-accent">#{meta.hashtags.join(' #')}</p> : null}
          {meta.tags.length > 0 ? <p className="mt-1 text-xs text-ink-faint">tags: {meta.tags.join(', ')}</p> : null}
        </>
      ) : (
        <div className="mt-2 space-y-2">
          <Field label="Title" hint={`${title.length}/100 characters`} required>
            <input className="input !py-1.5 text-xs" value={title} maxLength={100} onChange={(event) => setTitle(event.target.value)} />
          </Field>
          <Field label="Description" hint={`${description.length}/5000 characters`}>
            <textarea className="input min-h-[80px] !py-1.5 text-xs" value={description} maxLength={5000} onChange={(event) => setDescription(event.target.value)} />
          </Field>
          <Field label="Hashtags" hint="Space or comma separated, with or without #">
            <input className="input !py-1.5 text-xs" value={hashtags} onChange={(event) => setHashtags(event.target.value)} />
          </Field>
          <Field label="Tags" hint="Comma separated keywords">
            <input className="input !py-1.5 text-xs" value={tags} onChange={(event) => setTags(event.target.value)} />
          </Field>
          {error ? <ErrorState message={error} /> : null}
          <button type="button" className="btn-primary !px-3 !py-1.5 text-xs" onClick={() => save.mutate()} disabled={save.isPending || !title.trim()}>
            {save.isPending ? 'Saving…' : 'Save metadata'}
          </button>
        </div>
      )}
    </div>
  );
}

function PublishPanel({ clipId, platforms }: { clipId: string; platforms: boolean }) {
  const client = useQueryClient();
  const [scheduleAt, setScheduleAt] = useState('');
  const [selectedPlatforms, setSelectedPlatforms] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const publishing = usePublishing();
  const enqueue = useMutation({
    mutationFn: () =>
      api('/api/publishing/jobs', {
        method: 'POST',
        body: {
          clipId,
          platforms: selectedPlatforms,
          ...(scheduleAt ? { scheduledFor: new Date(scheduleAt).toISOString() } : {}),
        },
      }),
    onSuccess: () => {
      setError(null);
      void client.invalidateQueries({ queryKey: ['publishing'] });
      void client.invalidateQueries({ queryKey: ['clip', clipId] });
    },
    onError: (mutationError: Error) => setError(mutationError.message),
  });

  const connected = publishing.data
    ? Array.from(new Set(publishing.data.jobs.items.map((job) => job.platform)))
    : [];
  const choices = connected.length > 0 ? connected : ['YOUTUBE', 'INSTAGRAM'];

  return (
    <div className="space-y-2 border-t border-line pt-3">
      <p className="text-[13px] font-medium text-ink">Queue for publishing</p>
      <p className="hint">One job is created per selected platform. Accounts must be connected and publishing enabled first.</p>
      <div className="flex gap-2">
        {choices.map((platform) => (
          <button
            key={platform}
            type="button"
            onClick={() =>
              setSelectedPlatforms((current) =>
                current.includes(platform) ? current.filter((value) => value !== platform) : [...current, platform],
              )
            }
            className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition ${
              selectedPlatforms.includes(platform) ? 'border-accent bg-accent-soft text-accent-strong' : 'border-line text-ink-soft hover:border-accent/50'
            }`}
          >
            {platform === 'YOUTUBE' ? 'YouTube Shorts' : 'Instagram Reels'}
          </button>
        ))}
      </div>
      <Field label="Schedule (optional)" hint="Leave empty to publish as soon as a worker picks the job up.">
        <input type="datetime-local" className="input" value={scheduleAt} onChange={(event) => setScheduleAt(event.target.value)} />
      </Field>
      {error ? <ErrorState message={error} /> : null}
      <button
        type="button"
        className="btn-primary"
        disabled={!platforms || selectedPlatforms.length === 0 || enqueue.isPending}
        onClick={() => enqueue.mutate()}
      >
        {enqueue.isPending ? 'Queueing…' : 'Create publishing jobs'}
      </button>
      {publishing.data ? (
        <p className="hint">{publishing.data.jobs.total} publishing job(s) in total · {publishing.data.history.published.length} published</p>
      ) : null}
    </div>
  );
}
