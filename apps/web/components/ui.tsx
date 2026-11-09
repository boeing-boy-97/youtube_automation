'use client';

import clsx from 'clsx';
import type { ReactNode } from 'react';

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={clsx('card', className)}>{children}</div>;
}

export function CardHeader({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
      <div>
        <h2 className="text-[15px] font-semibold text-ink">{title}</h2>
        {description ? <p className="mt-0.5 text-[13px] text-ink-soft">{description}</p> : null}
      </div>
      {action}
    </div>
  );
}

const badgeTones: Record<string, string> = {
  neutral: 'bg-surface-sunken text-ink-soft',
  accent: 'bg-accent-soft text-accent-strong',
  positive: 'bg-positive-soft text-positive',
  caution: 'bg-caution-soft text-caution',
  danger: 'bg-danger-soft text-danger',
};

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: keyof typeof badgeTones }) {
  return <span className={clsx('badge', badgeTones[tone])}>{children}</span>;
}

const statusTones: Record<string, keyof typeof badgeTones> = {
  COMPLETED: 'positive',
  PUBLISHED: 'positive',
  READY: 'positive',
  healthy: 'positive',
  CONNECTED: 'positive',
  VALID: 'positive',
  RUNNING: 'accent',
  QUEUED: 'accent',
  PENDING: 'accent',
  PROBING: 'accent',
  TRANSCRIBING: 'accent',
  AI_ANALYSIS: 'accent',
  CLIP_SELECTION: 'accent',
  RENDERING: 'accent',
  VALIDATION: 'accent',
  ASSET_STORAGE: 'accent',
  PUBLISHING_QUEUED: 'accent',
  PUBLISHING: 'accent',
  UPLOADING: 'accent',
  AWAITING_PLATFORM: 'accent',
  RETRYING: 'caution',
  PARTIALLY_COMPLETED: 'caution',
  PARTIALLY_PUBLISHED: 'caution',
  NEEDS_CONFIGURATION: 'caution',
  degraded: 'caution',
  unconfigured: 'caution',
  EXPIRING_SOON: 'caution',
  QUEUED_PUBLISH: 'accent',
  FAILED: 'danger',
  RENDER_FAILED: 'danger',
  PUBLISH_FAILED: 'danger',
  down: 'danger',
  ERROR: 'danger',
  EXPIRED: 'danger',
  CANCELLED: 'neutral',
};

export function StatusBadge({ value }: { value: string | null | undefined }) {
  const raw = typeof value === 'string' && value.length > 0 ? value : 'unknown';
  const tone = statusTones[raw] ?? 'neutral';
  return <Badge tone={tone}>{raw.replaceAll('_', ' ').toLowerCase()}</Badge>;
}

export function ProgressBar({ value, tone = 'accent' }: { value: number; tone?: 'accent' | 'positive' | 'danger' }) {
  const clamped = Math.max(0, Math.min(100, value));
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-sunken">
      <div
        className={clsx('h-full rounded-full transition-all duration-500', {
          'bg-accent': tone === 'accent',
          'bg-positive': tone === 'positive',
          'bg-danger': tone === 'danger',
        })}
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}

export function StatCard({ label, value, hint, tone }: { label: string; value: string | number; hint?: string; tone?: 'default' | 'danger' | 'positive' | 'caution' }) {
  return (
    <Card className="px-5 py-4">
      <p className="text-[13px] font-medium text-ink-soft">{label}</p>
      <p
        className={clsx('mt-1 text-2xl font-semibold tracking-tight', {
          'text-ink': !tone || tone === 'default',
          'text-danger': tone === 'danger',
          'text-positive': tone === 'positive',
          'text-caution': tone === 'caution',
        })}
      >
        {value}
      </p>
      {hint ? <p className="mt-1 text-xs text-ink-faint">{hint}</p> : null}
    </Card>
  );
}

export function Field({ label, hint, children, required }: { label: string; hint?: string; children: ReactNode; required?: boolean }) {
  return (
    <label className="block">
      <span className="label">
        {label}
        {required ? <span className="ml-0.5 text-danger">*</span> : null}
      </span>
      <div className="mt-1.5">{children}</div>
      {hint ? <p className="mt-1 hint">{hint}</p> : null}
    </label>
  );
}

export function EmptyState({ title, description, action }: { title: string; description: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center">
      <div className="mb-1 flex h-10 w-10 items-center justify-center rounded-full bg-surface-sunken text-ink-faint">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M4 7h16M4 12h16M4 17h10" strokeLinecap="round" />
        </svg>
      </div>
      <p className="text-sm font-medium text-ink">{title}</p>
      <p className="max-w-sm text-[13px] text-ink-soft">{description}</p>
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

export function ErrorState({ message, onRetry, code, missing }: { message: string; onRetry?: () => void; code?: string; missing?: string[] }) {
  return (
    <div className="rounded-xl2 border border-danger/30 bg-danger-soft px-4 py-3 text-sm">
      <p className="font-medium text-danger">{code ? `${code}: ` : ''}{message}</p>
      {missing && missing.length > 0 ? (
        <ul className="mt-2 list-disc space-y-0.5 pl-5 text-[13px] text-danger">
          {missing.map((key) => (
            <li key={key}>
              <code className="rounded bg-white/70 px-1 py-0.5 font-mono text-xs">{key}</code>
            </li>
          ))}
        </ul>
      ) : null}
      {onRetry ? (
        <button type="button" onClick={onRetry} className="btn-secondary mt-3">
          Retry
        </button>
      ) : null}
    </div>
  );
}

export function Skeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-2 p-5">
      {Array.from({ length: rows }).map((_, index) => (
        <div key={index} className="h-9 animate-pulse rounded-lg bg-surface-sunken" />
      ))}
    </div>
  );
}

export function Toast({ tone = 'neutral', children, onClose }: { tone?: 'neutral' | 'positive' | 'danger'; children: ReactNode; onClose?: () => void }) {
  return (
    <div
      className={clsx('animate-fade-up fixed bottom-5 right-5 z-50 flex max-w-sm items-start gap-3 rounded-xl2 border px-4 py-3 text-sm shadow-pop', {
        'border-line bg-white text-ink': tone === 'neutral',
        'border-positive/30 bg-positive-soft text-positive': tone === 'positive',
        'border-danger/30 bg-danger-soft text-danger': tone === 'danger',
      })}
    >
      <span className="flex-1">{children}</span>
      {onClose ? (
        <button type="button" onClick={onClose} className="text-ink-faint hover:text-ink" aria-label="Dismiss">
          ×
        </button>
      ) : null}
    </div>
  );
}

export function Section({ title, description, children, action }: { title: string; description?: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <section className="space-y-3">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h2 className="text-[17px] font-semibold tracking-tight text-ink">{title}</h2>
          {description ? <p className="mt-0.5 text-[13px] text-ink-soft">{description}</p> : null}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}
