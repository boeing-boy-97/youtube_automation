import { Injectable } from '@nestjs/common';
import { prisma } from '@clipforge/database';
import { priceList, round, type PriceList } from '../common/services/usage-cost';

export interface UsageWindow {
  from: Date;
  to: Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** Default reporting window: the last 30 days, which is what a monthly review looks at. */
const DEFAULT_WINDOW_DAYS = 30;

const KIND_LABELS: Record<string, string> = {
  transcription_seconds: 'Transcription (audio seconds)',
  gemini_tokens: 'AI text analysis (tokens)',
  gemini_vision_tokens: 'AI vision analysis (tokens)',
  render_seconds: 'Rendering (video seconds)',
  storage_bytes: 'Storage (bytes written)',
  publish_calls: 'Platform publish calls',
};

const UNIT_BY_KIND: Record<string, string> = {
  transcription_seconds: 'seconds',
  gemini_tokens: 'tokens',
  gemini_vision_tokens: 'tokens',
  render_seconds: 'seconds',
  storage_bytes: 'bytes',
  publish_calls: 'calls',
};

export interface KindSummary {
  kind: string;
  label: string;
  unit: string;
  quantity: number;
  records: number;
  costUsd: number;
  unpricedRecords: number;
}

export interface UsageSummary {
  workspaceId: string;
  window: { from: string; to: string; days: number };
  totals: {
    costUsd: number;
    records: number;
    unpricedRecords: number;
    tokens: number;
    transcriptionSeconds: number;
    renderSeconds: number;
    publishCalls: number;
    storageBytesWritten: number;
  };
  byKind: KindSummary[];
  /** Storage is a monthly rate over what is currently stored, not a per-upload charge. */
  storage: { bytesStoredNow: number; monthlyCostUsd: number; pricePerGbMonth: number };
  prices: PriceList;
  generatedAt: string;
}

@Injectable()
export class UsageService {
  /** Aggregate spend for a workspace over a window. Read-only; no rows are created here. */
  async summary(workspaceId: string, query: { from?: string; to?: string }): Promise<UsageSummary> {
    const window = resolveWindow(query);
    const records = await prisma.usageRecord.findMany({
      where: { workspaceId, recordedAt: { gte: window.from, lte: window.to } },
      select: { kind: true, quantity: true, costUsd: true },
    });

    const byKind = new Map<string, KindSummary>();
    for (const record of records) {
      const entry =
        byKind.get(record.kind) ??
        ({
          kind: record.kind,
          label: KIND_LABELS[record.kind] ?? record.kind,
          unit: UNIT_BY_KIND[record.kind] ?? 'units',
          quantity: 0,
          records: 0,
          costUsd: 0,
          unpricedRecords: 0,
        } satisfies KindSummary);
      entry.quantity = round(entry.quantity + record.quantity);
      entry.records += 1;
      // A null cost means "we did not price this", which is different from costing zero.
      if (record.costUsd === null || record.costUsd === undefined) entry.unpricedRecords += 1;
      else entry.costUsd = round(entry.costUsd + record.costUsd);
      byKind.set(record.kind, entry);
    }

    const byKindSorted = [...byKind.values()].sort((a, b) => b.costUsd - a.costUsd || a.kind.localeCompare(b.kind));
    const prices = priceList();

    const storageAggregate = await prisma.usageRecord.aggregate({
      where: { workspaceId, kind: 'storage_bytes', recordedAt: { gte: window.from, lte: window.to } },
      _sum: { quantity: true },
    });
    const bytesWritten = storageAggregate._sum.quantity ?? 0;

    return {
      workspaceId,
      window: {
        from: window.from.toISOString(),
        to: window.to.toISOString(),
        days: Math.max(1, Math.round((window.to.getTime() - window.from.getTime()) / DAY_MS)),
      },
      totals: {
        costUsd: round(byKindSorted.reduce((sum, entry) => sum + entry.costUsd, 0)),
        records: records.length,
        unpricedRecords: byKindSorted.reduce((sum, entry) => sum + entry.unpricedRecords, 0),
        tokens: round(
          (byKind.get('gemini_tokens')?.quantity ?? 0) + (byKind.get('gemini_vision_tokens')?.quantity ?? 0),
        ),
        transcriptionSeconds: round(byKind.get('transcription_seconds')?.quantity ?? 0),
        renderSeconds: round(byKind.get('render_seconds')?.quantity ?? 0),
        publishCalls: round(byKind.get('publish_calls')?.quantity ?? 0),
        storageBytesWritten: round(bytesWritten),
      },
      byKind: byKindSorted,
      storage: {
        bytesStoredNow: await this.bytesCurrentlyStored(workspaceId),
        monthlyCostUsd: round(((await this.bytesCurrentlyStored(workspaceId)) / 1024 ** 3) * prices.storagePerGbMonth),
        pricePerGbMonth: prices.storagePerGbMonth,
      },
      prices,
      generatedAt: new Date().toISOString(),
    };
  }

  /** Daily spend series, useful for spotting a runaway job or a pricing change. */
  async daily(workspaceId: string, query: { from?: string; to?: string }) {
    const window = resolveWindow(query);
    const records = await prisma.usageRecord.findMany({
      where: { workspaceId, recordedAt: { gte: window.from, lte: window.to }, costUsd: { not: null } },
      select: { kind: true, costUsd: true, recordedAt: true },
    });
    const buckets = new Map<string, { date: string; costUsd: number; records: number; byKind: Record<string, number> }>();
    for (const record of records) {
      const date = record.recordedAt.toISOString().slice(0, 10);
      const bucket = buckets.get(date) ?? { date, costUsd: 0, records: 0, byKind: {} };
      bucket.costUsd = round(bucket.costUsd + (record.costUsd ?? 0));
      bucket.records += 1;
      bucket.byKind[record.kind] = round((bucket.byKind[record.kind] ?? 0) + (record.costUsd ?? 0));
      buckets.set(date, bucket);
    }
    return {
      workspaceId,
      window: { from: window.from.toISOString(), to: window.to.toISOString() },
      days: [...buckets.values()].sort((a, b) => a.date.localeCompare(b.date)),
    };
  }

  /** Raw ledger, newest first. This is what an operator reconciles against provider invoices. */
  async records(
    workspaceId: string,
    query: { page: number; pageSize: number; kind?: string; jobId?: string; from?: string; to?: string },
  ) {
    const window = resolveWindow(query);
    const where = {
      workspaceId,
      ...(query.kind ? { kind: query.kind } : {}),
      ...(query.jobId ? { jobId: query.jobId } : {}),
      recordedAt: { gte: window.from, lte: window.to },
    };
    const [total, rows] = await Promise.all([
      prisma.usageRecord.count({ where }),
      prisma.usageRecord.findMany({
        where,
        orderBy: { recordedAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        select: {
          id: true,
          kind: true,
          quantity: true,
          unit: true,
          costUsd: true,
          metadata: true,
          recordedAt: true,
          jobId: true,
        },
      }),
    ]);
    return {
      total,
      page: query.page,
      pageSize: query.pageSize,
      items: rows.map((row) => ({ ...row, label: KIND_LABELS[row.kind] ?? row.kind })),
    };
  }

  /**
   * Bytes currently held: the latest storage write per source video, summed. Storage records are
   * written on upload, so the newest record per source is the file that exists now; superseded and
   * deleted files must not inflate the number.
   */
  private async bytesCurrentlyStored(workspaceId: string): Promise<number> {
    const rows = await prisma.usageRecord.findMany({
      where: { workspaceId, kind: 'storage_bytes' },
      select: { quantity: true, metadata: true, recordedAt: true },
      orderBy: { recordedAt: 'desc' },
    });
    const latestPerSource = new Map<string, number>();
    for (const row of rows) {
      const metadata = (row.metadata ?? {}) as { sourceVideoId?: string };
      const key = metadata.sourceVideoId ?? `unattributed-${latestPerSource.size}`;
      if (!latestPerSource.has(key)) latestPerSource.set(key, row.quantity);
    }
    return round([...latestPerSource.values()].reduce((sum, value) => sum + value, 0));
  }
}

function resolveWindow(query: { from?: string; to?: string }): UsageWindow {
  const to = query.to ? new Date(query.to) : new Date();
  const from = query.from
    ? new Date(query.from)
    : new Date(to.getTime() - DEFAULT_WINDOW_DAYS * DAY_MS);
  return { from, to };
}
