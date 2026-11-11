/**
 * Message rendering for Telegram notifications.
 *
 * Pure functions, no I/O: every message the system sends is built here, which makes the wording
 * reviewable and unit-testable without a bot, a database or a network.
 *
 * Two rules the templates follow:
 *
 *  1. **No unverified claims.** A template may only state what the caller already knows happened.
 *     "Upload completed" is rendered only from the publish success path, never from a queued state.
 *  2. **Always an execution id.** Every workflow-related message carries the job id, so an operator
 *     reading their phone can find the run it refers to.
 */
import { NOTIFICATION_CATEGORY_META, type NotificationCategory, type NotificationSeverity } from '@clipforge/shared-types';

const SEVERITY_ICON: Record<NotificationSeverity, string> = {
  info: 'ℹ️',
  success: '✅',
  warning: '⚠️',
  error: '🚨',
};

/** Telegram HTML parse mode: only these three entities are allowed, so user text must be escaped. */
export function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export interface NotificationTemplateInput {
  category: NotificationCategory;
  severity: NotificationSeverity;
  workspaceName: string;
  /** Human-readable one-line summary: the fact that just became true. */
  summary: string;
  /** Extra labelled lines, rendered in order. Values are escaped. */
  details?: Array<[label: string, value: string | number | null | undefined]>;
  /** Execution id: the processing job, publishing job or clip the message is about. */
  executionId?: string | null;
  /** ISO timestamp; rendered in the operator's timezone when one is supplied. */
  occurredAt?: Date;
  timezone?: string | null;
}

export function formatTime(date: Date, timezone?: string | null): string {
  const zone = timezone?.trim() || 'UTC';
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: zone,
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZoneName: 'short',
    }).format(date);
  } catch {
    // An unknown timezone must not lose the notification; fall back to UTC.
    return `${date.toISOString().replace('T', ' ').slice(0, 16)} UTC`;
  }
}

/** Short form for an operator reading a phone: first 8 characters of a UUID. */
export function shortId(id: string | null | undefined): string {
  if (!id) return '—';
  return id.length > 12 ? id.slice(0, 8) : id;
}

export function renderNotification(input: NotificationTemplateInput): string {
  const lines: string[] = [];
  const title = NOTIFICATION_CATEGORY_META[input.category]?.label ?? humanise(input.category);
  lines.push(`${SEVERITY_ICON[input.severity]} <b>ClipForge · ${escapeHtml(title)}</b>`);
  lines.push(escapeHtml(input.summary));
  const details = (input.details ?? []).filter(([, value]) => value !== null && value !== undefined && `${value}` !== '');
  if (details.length) {
    lines.push('');
    for (const [label, value] of details) {
      lines.push(`<b>${escapeHtml(label)}:</b> ${escapeHtml(String(value))}`);
    }
  }
  if (input.executionId) {
    lines.push('');
    lines.push(`<b>Execution:</b> <code>${escapeHtml(input.executionId)}</code>`);
  }
  lines.push('');
  lines.push(
    `<i>${escapeHtml(input.workspaceName)} · ${escapeHtml(formatTime(input.occurredAt ?? new Date(), input.timezone))}</i>`,
  );
  return lines.join('\n');
}

function humanise(category: string): string {
  return category
    .toLowerCase()
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}
