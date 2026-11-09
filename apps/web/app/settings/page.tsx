'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useConfiguration, useIsOperator, useSaveConfiguration, useSystemOverview } from '@/lib/hooks';
import { CONFIG_FIELDS, CONFIG_GROUPS, type ConfigField } from '@/lib/config-schema';
import { Badge, Card, CardHeader, ErrorState, Field, Section, Skeleton, StatusBadge, Toast } from '@/components/ui';

type Draft = Record<string, string | boolean>;

function toDraft(values: Record<string, unknown>): Draft {
  const draft: Draft = {};
  for (const field of CONFIG_FIELDS) {
    const value = values[field.key];
    if (value === undefined || value === null) continue;
    draft[field.key] = field.kind === 'boolean' ? Boolean(value) : Array.isArray(value) ? value.join(', ') : String(value);
  }
  return draft;
}

function parseValue(field: ConfigField, raw: string | boolean): unknown {
  if (field.kind === 'boolean') return Boolean(raw);
  const text = String(raw).trim();
  if (field.kind === 'integer') return Number.parseInt(text, 10);
  if (field.kind === 'number') return Number.parseFloat(text);
  if (field.kind === 'list') return text.split(',').map((item) => item.trim()).filter(Boolean);
  return text;
}

export default function SettingsPage() {
  const configuration = useConfiguration();
  // Configuration writes are OWNER/ADMIN only on the API; members get a read-only view instead of
  // a form whose save button can only produce a 403.
  const isOperator = useIsOperator();
  const system = useSystemOverview(isOperator);
  const save = useSaveConfiguration();
  const [draft, setDraft] = useState<Draft>({});
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (configuration.data && dirty.size === 0) setDraft(toDraft(configuration.data.values));
  }, [configuration.data, dirty.size]);

  const missing = useMemo(() => configuration.data?.missingForProcessing ?? [], [configuration.data]);
  if (configuration.isLoading) return <Card><Skeleton rows={8} /></Card>;
  if (configuration.error) return <ErrorState message={configuration.error.message} onRetry={() => void configuration.refetch()} />;
  const data = configuration.data!;

  const setValue = (key: string, value: string | boolean) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setDirty((current) => new Set(current).add(key));
    setSaved(false);
  };

  const submit = () => {
    setError(null);
    const entries: Array<{ key: string; value: unknown }> = [];
    for (const key of dirty) {
      const field = CONFIG_FIELDS.find((item) => item.key === key);
      if (!field) continue;
      const raw = draft[key];
      if (raw === undefined || raw === '') continue;
      const value = parseValue(field, raw);
      if ((field.kind === 'integer' || field.kind === 'number') && typeof value === 'number' && Number.isNaN(value)) {
        setError(`${field.label} expects a number`);
        return;
      }
      entries.push({ key, value });
    }
    if (entries.length === 0) {
      setError('Nothing changed yet — update at least one setting before saving.');
      return;
    }
    save.mutate(entries, {
      onSuccess: () => {
        setDirty(new Set());
        setSaved(true);
        void configuration.refetch();
      },
      onError: (mutationError: Error) => setError(mutationError.message),
    });
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-ink">Configuration</h1>
          <p className="mt-0.5 text-[13px] text-ink-soft">
            Nothing has a built-in default. Processing stays blocked until every required value is set explicitly.
          </p>
        </div>
        {isOperator ? (
          <div className="flex items-center gap-2">
            <button type="button" className="btn-ghost" onClick={() => { setDraft(toDraft(data.values)); setDirty(new Set()); setSaved(false); }}>Reset changes</button>
            <button type="button" className="btn-primary" onClick={submit} disabled={save.isPending || dirty.size === 0}>
              {save.isPending ? 'Saving…' : `Save ${dirty.size > 0 ? `${dirty.size} change(s)` : ''}`}
            </button>
          </div>
        ) : (
          <Badge tone="neutral">Read-only · operators only</Badge>
        )}
      </div>

      {missing.length > 0 ? (
        <ErrorState code="CONFIGURATION_REQUIRED" message="Configuration required — processing cannot start." missing={missing} />
      ) : (
        <div className="rounded-xl2 border border-positive/30 bg-positive-soft px-4 py-3 text-[13px] text-positive">
          All required processing configuration is present. Publishing still requires an enabled connected account.
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <Card className="px-5 py-4">
          <p className="text-[13px] font-semibold text-ink">Environment integrations</p>
          <p className="mt-0.5 text-xs text-ink-faint">Read from server environment variables — never stored in the database or exposed to the browser.</p>
          <ul className="mt-3 space-y-1.5 text-[13px]">
            {system.data
              ? [
                  system.data.readiness.components.ai,
                  system.data.readiness.components.vp,
                  system.data.readiness.components.storage,
                  ...system.data.readiness.components.integration,
                ].map((component) => (
                  <li key={component.component} className="flex items-center justify-between gap-3">
                    <span className="text-ink-soft">{component.component}</span>
                    <span className="flex items-center gap-2">
                      <span className="max-w-[190px] truncate text-xs text-ink-faint">{component.message}</span>
                      <StatusBadge value={component.status} />
                    </span>
                  </li>
                ))
              : <Skeleton rows={3} />}
          </ul>
        </Card>
        <Card className="px-5 py-4">
          <p className="text-[13px] font-semibold text-ink">Publishing readiness</p>
          <p className="mt-0.5 text-xs text-ink-faint">Meta Graph API version is pinned in the API environment.</p>
          <div className="mt-3 space-y-1.5 text-[13px]">
            <div className="flex items-center justify-between">
              <span className="text-ink-soft">Graph API version</span>
              <Badge tone={system.data?.graphApiVersion ? 'positive' : 'caution'}>{system.data?.graphApiVersion ?? 'not set'}</Badge>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-ink-soft">Storage driver</span>
              <Badge tone="neutral">{system.data?.storage.driver ?? '—'}</Badge>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-ink-soft">Public media base URL</span>
              <Badge tone={system.data?.storage.publicUrlConfigured ? 'positive' : 'caution'}>
                {system.data?.storage.publicUrlConfigured ? 'configured' : 'not configured'}
              </Badge>
            </div>
            {data.missingForPublishing.length > 0 ? (
              <p className="pt-1 text-xs text-caution">Publishing keys missing: {data.missingForPublishing.join(', ')}</p>
            ) : null}
            <Link href="/accounts" className="inline-block pt-1 text-xs font-medium text-accent hover:underline">Manage accounts →</Link>
          </div>
        </Card>
      </div>

      {error ? <ErrorState message={error} /> : null}
      {saved ? <Toast tone="positive" onClose={() => setSaved(false)}>Configuration saved and audited.</Toast> : null}

      {!isOperator ? (
        <Card className="px-5 py-4">
          <p className="text-[13px] font-semibold text-ink">Read-only view</p>
          <p className="mt-1 text-[13px] text-ink-soft">
            Only workspace owners and admins can change processing configuration, brand assets, connected accounts
            and automatic publishing. Ask an owner if a value needs to change.
          </p>
        </Card>
      ) : null}

      {!isOperator ? null : CONFIG_GROUPS.map((group) => (
        <Card key={group}>
          <CardHeader title={group} description={`${CONFIG_FIELDS.filter((field) => field.group === group).length} setting(s)`} />
          <div className="grid gap-4 px-5 py-5 md:grid-cols-2">
            {CONFIG_FIELDS.filter((field) => field.group === group).map((field) => {
              const value = draft[field.key];
              const isMissing = missing.includes(field.key);
              return (
                <div key={field.key} className={isMissing ? 'rounded-lg bg-danger-soft/40 p-2' : undefined}>
                  <Field
                    label={field.label}
                    hint={field.hint}
                    required={data.requiredForProcessing.includes(field.key) || data.requiredForPublishing.includes(field.key)}
                  >
                    {field.kind === 'boolean' ? (
                      <label className="flex items-center gap-2 text-[13px] text-ink-soft">
                        <input type="checkbox" checked={Boolean(value)} onChange={(event) => setValue(field.key, event.target.checked)} />
                        {value === undefined ? 'Not set' : value ? 'Enabled' : 'Disabled'}
                      </label>
                    ) : field.kind === 'select' ? (
                      <select className="input" value={value === undefined ? '' : String(value)} onChange={(event) => setValue(field.key, event.target.value)}>
                        <option value="">Select…</option>
                        {field.options!.map((option) => (
                          <option key={String(option.value)} value={String(option.value)}>{option.label}</option>
                        ))}
                      </select>
                    ) : field.kind === 'preset' ? (
                      <select className="input" value={value === undefined ? '' : String(value)} onChange={(event) => setValue(field.key, event.target.value)}>
                        <option value="">Select a preset…</option>
                        {data.subtitlePresets.map((preset) => (
                          <option key={preset.id} value={preset.id}>{preset.name}{preset.isSystem ? ' (system)' : ''}</option>
                        ))}
                      </select>
                    ) : (
                      <input
                        className="input"
                        type={field.kind === 'integer' || field.kind === 'number' ? 'number' : 'text'}
                        step={field.kind === 'number' ? 'any' : undefined}
                        min={field.min}
                        max={field.max}
                        value={value === undefined ? '' : String(value)}
                        placeholder={field.kind === 'integer' || field.kind === 'number' ? 'Required' : 'Required'}
                        onChange={(event) => setValue(field.key, event.target.value)}
                      />
                    )}
                  </Field>
                  <p className="mt-1 font-mono text-[11px] text-ink-faint">{field.key}{isMissing ? ' · missing' : ''}</p>
                </div>
              );
            })}
          </div>
          {group === 'Subtitles' ? (
            <p className="border-t border-line px-5 py-3 text-xs text-ink-soft">
              Need a new style? <Link href="/brand" className="font-medium text-accent hover:underline">Create a subtitle preset in Brand studio</Link>.
            </p>
          ) : null}
        </Card>
      ))}

      <Section title="Session & security" description="Applied by the API, not configurable from the browser">
        <Card>
          <ul className="divide-y divide-line text-[13px]">
            {[
              ['Password hashing', 'Argon2id with per-user salt'],
              ['Session', 'HMAC-signed cookie, HttpOnly, SameSite=Lax, DB-backed revocation'],
              ['CSRF', 'Double-submit token, verified server-side on every mutating request'],
              ['Credentials at rest', 'AES-256-GCM with an environment-provided key'],
              ['Audit trail', 'Every mutation writes an append-only audit row'],
            ].map(([label, value]) => (
              <li key={label} className="flex items-center justify-between gap-3 px-5 py-2.5">
                <span className="font-medium text-ink">{label}</span>
                <span className="text-ink-soft">{value}</span>
              </li>
            ))}
          </ul>
        </Card>
      </Section>
    </div>
  );
}
