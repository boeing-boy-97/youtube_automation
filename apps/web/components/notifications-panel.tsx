'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  useNotificationCategories,
  useNotificationHistory,
  useNotificationStatus,
  useSendTestNotification,
  useUpdateNotificationSettings,
} from '@/lib/hooks';
import { formatRelative } from '@/lib/api';
import { Badge, Card, CardHeader, ErrorState, Field, Skeleton, StatusBadge, Toast } from './ui';

/**
 * Telegram notification settings.
 *
 * Everything here is state the API owns: the toggles are written to ApplicationConfiguration, the
 * status is measured (bot identity, last delivery, 24h counters), and the test button sends a real
 * message through the real delivery path. The bot token is never part of this UI because it never
 * leaves the API process — the panel only ever learns whether it is present.
 */
export function NotificationsPanel() {
  const status = useNotificationStatus();
  const catalogue = useNotificationCategories();
  const history = useNotificationHistory();
  const update = useUpdateNotificationSettings();
  const test = useSendTestNotification();

  const [enabled, setEnabled] = useState(false);
  const [chatId, setChatId] = useState('');
  const [categories, setCategories] = useState<string[]>([]);
  const [hour, setHour] = useState(9);
  const [dirty, setDirty] = useState(false);
  const [note, setNote] = useState('');

  const data = status.data;

  // Seed the form from the server once per load; a poll must not overwrite what is being typed.
  useEffect(() => {
    if (!data || dirty) return;
    setEnabled(data.enabled);
    setChatId('');
    setCategories(data.categories);
    setHour(data.dailySummaryHour);
  }, [data, dirty]);

  const options = useMemo(() => catalogue.data?.categories ?? [], [catalogue.data]);

  if (status.isLoading) return <Card><Skeleton rows={5} /></Card>;
  if (status.error) return <ErrorState message={status.error.message} onRetry={() => void status.refetch()} />;

  const save = () => {
    update.mutate(
      {
        enabled,
        // An empty box means "keep using TELEGRAM_CHAT_ID from the environment", not "clear it".
        chatId: chatId.trim() ? chatId.trim() : undefined,
        categories,
        dailySummaryHour: hour,
      },
      { onSuccess: () => { setDirty(false); setChatId(''); } },
    );
  };

  const toggleCategory = (value: string) => {
    setDirty(true);
    setCategories((current) => (current.includes(value) ? current.filter((c) => c !== value) : [...current, value]));
  };

  return (
    <Card>
      <CardHeader
        title="Telegram notifications"
        description="Server-side delivery of automation events. Messages are sent by the API and the workers, so they arrive with the browser closed."
        action={
          <Badge tone={data!.canSend ? 'positive' : data!.tokenConfigured ? 'caution' : 'danger'}>
            {data!.canSend ? 'Ready' : data!.tokenConfigured ? 'Incomplete' : 'Not configured'}
          </Badge>
        }
      />

      <div className="space-y-4 px-5 py-4">
        {/* ------------------------------------------------------------- status */}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-lg bg-surface-sunken px-3 py-2">
            <p className="text-[11px] font-medium uppercase tracking-wide text-ink-faint">Bot token</p>
            <p className="mt-0.5 text-[13px] font-medium text-ink">
              {data!.tokenConfigured ? 'Set on the API' : 'Missing'}
            </p>
            <p className="mt-0.5 text-[11px] text-ink-faint">
              {data!.bot.reachable ? `@${data!.bot.username ?? 'bot'}` : data!.bot.error ?? 'Not probed yet'}
            </p>
          </div>
          <div className="rounded-lg bg-surface-sunken px-3 py-2">
            <p className="text-[11px] font-medium uppercase tracking-wide text-ink-faint">Chat</p>
            <p className="mt-0.5 text-[13px] font-medium text-ink">{data!.chatIdMasked ?? 'Not set'}</p>
            <p className="mt-0.5 text-[11px] text-ink-faint">
              {data!.chatIdConfigured ? 'Destination configured' : 'Set TELEGRAM_CHAT_ID or type one below'}
            </p>
          </div>
          <div className="rounded-lg bg-surface-sunken px-3 py-2">
            <p className="text-[11px] font-medium uppercase tracking-wide text-ink-faint">Last delivered</p>
            <p className="mt-0.5 text-[13px] font-medium text-ink">
              {data!.lastDeliveryAt ? formatRelative(data!.lastDeliveryAt) : 'Never'}
            </p>
            <p className="mt-0.5 text-[11px] text-ink-faint">{data!.lastDeliveryCategory ?? '—'}</p>
          </div>
          <div className="rounded-lg bg-surface-sunken px-3 py-2">
            <p className="text-[11px] font-medium uppercase tracking-wide text-ink-faint">Last 24h</p>
            <p className="mt-0.5 text-[13px] font-medium text-ink">
              {data!.last24h.sent} sent · {data!.last24h.failed} failed
            </p>
            <p className="mt-0.5 text-[11px] text-ink-faint">
              {data!.lastError ? `Last error: ${data!.lastError.slice(0, 60)}` : 'No delivery errors'}
            </p>
          </div>
        </div>

        {data!.blockingReason ? (
          <p className="rounded-lg bg-caution-soft px-3 py-2 text-[12px] text-caution">{data!.blockingReason}</p>
        ) : null}

        {/* ------------------------------------------------------------ controls */}
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-3">
            <label className="flex items-center gap-2.5 text-[13px] text-ink">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-line"
                checked={enabled}
                onChange={(event) => { setEnabled(event.target.checked); setDirty(true); }}
              />
              Send Telegram notifications for this workspace
            </label>

            <Field
              label="Chat id override"
              hint="Leave empty to use TELEGRAM_CHAT_ID from the server environment. A group id looks like -1001234567890."
            >
              <input
                className="input"
                placeholder={data!.chatIdMasked ?? '-1001234567890'}
                value={chatId}
                onChange={(event) => { setChatId(event.target.value); setDirty(true); }}
              />
            </Field>

            <Field label="Daily summary hour" hint="Local hour in the workspace timezone (0–23).">
              <input
                type="number"
                min={0}
                max={23}
                className="input"
                value={hour}
                onChange={(event) => { setHour(Number(event.target.value)); setDirty(true); }}
              />
            </Field>

            <div className="flex flex-wrap gap-2">
              <button type="button" className="btn-primary" onClick={save} disabled={update.isPending || !dirty}>
                {update.isPending ? 'Saving…' : 'Save settings'}
              </button>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => test.mutate(note || undefined)}
                disabled={test.isPending}
              >
                {test.isPending ? 'Sending…' : 'Test connection'}
              </button>
            </div>
            <input
              className="input"
              placeholder="Optional note for the test message"
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
            {update.isError ? <p className="text-[12px] text-danger">{update.error.message}</p> : null}
            {test.data ? (
              <Toast tone={test.data.delivered ? 'positive' : 'danger'}>
                {test.data.delivered
                  ? `Delivered to ${test.data.chatIdMasked ?? 'chat'} on attempt ${test.data.attempts}.`
                  : `Not delivered: ${test.data.error ?? 'unknown error'}`}
              </Toast>
            ) : null}
            {test.isError ? <p className="text-[12px] text-danger">{test.error.message}</p> : null}
          </div>

          {/* --------------------------------------------------------- categories */}
          <div>
            <p className="label">Notification categories</p>
            <ul className="mt-1.5 max-h-64 space-y-1 overflow-y-auto rounded-lg border border-line px-3 py-2">
              {options.map((option) => (
                <li key={option.value}>
                  {/* The label wraps the checkbox so the visible category name is its accessible
                      name — otherwise a screen reader announces 16 unnamed checkboxes. */}
                  <label className="flex cursor-pointer items-start gap-2 py-1">
                    <input
                      type="checkbox"
                      className="mt-0.5 h-4 w-4 rounded border-line"
                      checked={categories.includes(option.value)}
                      onChange={() => toggleCategory(option.value)}
                    />
                    <span>
                      <span className="block text-[13px] text-ink">{option.label}</span>
                      <span className="block text-[11px] text-ink-faint">{option.description}</span>
                    </span>
                  </label>
                </li>
              ))}
              {options.length === 0 ? <li className="py-2 text-[12px] text-ink-faint">Loading categories…</li> : null}
            </ul>
            <p className="mt-1.5 text-[11px] text-ink-faint">
              Only enabled categories are sent. Everything else is still written to the audit log and the job history.
            </p>
          </div>
        </div>

        {/* ------------------------------------------------------------ history */}
        <div>
          <p className="label">Notification history</p>
          {history.isLoading ? (
            <Skeleton rows={3} />
          ) : history.data && history.data.items.length > 0 ? (
            <ul className="mt-1.5 divide-y divide-line rounded-lg border border-line">
              {history.data.items.map((row) => (
                <li key={row.id} className="px-3 py-2">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-[12px] font-medium text-ink">{row.category}</span>
                    <span className="flex items-center gap-2">
                      <StatusBadge value={row.status} />
                      <span className="text-[11px] text-ink-faint">{formatRelative(row.sentAt ?? row.createdAt)}</span>
                    </span>
                  </div>
                  <p className="mt-0.5 line-clamp-1 text-[11px] text-ink-soft">
                    {row.message.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()}
                  </p>
                  {row.lastError ? (
                    <p className="mt-0.5 text-[11px] text-danger">
                      {row.attempts} attempt(s): {row.lastError}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1.5 rounded-lg border border-line px-3 py-3 text-[12px] text-ink-faint">
              Nothing sent yet. Run a workflow, or press “Test connection”.
            </p>
          )}
        </div>
      </div>
    </Card>
  );
}
