'use client';

import { useState } from 'react';
import { useActivity } from '@/lib/hooks';
import { Card, CardHeader, EmptyState, ErrorState, Section, Skeleton } from '@/components/ui';
import { formatRelative } from '@/lib/api';

export default function ActivityPage() {
  const [limit, setLimit] = useState(100);
  const activity = useActivity(limit);

  return (
    <div className="space-y-5">
      <Section
        as="h1"
        title="Activity log"
        description="Append-only audit trail. Every mutation writes a row with the acting user, IP and request id."
        action={
          <select aria-label="Number of events to show" className="input !w-auto !py-1.5 text-[13px]" value={limit} onChange={(event) => setLimit(Number(event.target.value))}>
            {[50, 100, 200, 500].map((value) => <option key={value} value={value}>Last {value}</option>)}
          </select>
        }
      />
      <Card>
        <CardHeader title={activity.data ? `${activity.data.items.length} event(s)` : 'Loading'} />
        {activity.isLoading ? (
          <Skeleton rows={6} />
        ) : activity.error ? (
          <div className="p-5"><ErrorState message={activity.error.message} onRetry={() => void activity.refetch()} /></div>
        ) : activity.data!.items.length === 0 ? (
          <EmptyState title="No activity yet" description="Actions such as sign-in, uploads and configuration changes appear here." />
        ) : (
          <div className="overflow-x-auto">
            <table className="table w-full">
              <thead>
                <tr><th>Action</th><th>Summary</th><th>Target</th><th>When</th></tr>
              </thead>
              <tbody>
                {activity.data!.items.map((item) => (
                  <tr key={item.id}>
                    <td className="whitespace-nowrap font-mono text-xs text-ink-soft">{item.action}</td>
                    <td className="text-[13px] text-ink">{item.summary}</td>
                    <td className="text-xs text-ink-faint">{item.targetType ? `${item.targetType}${item.targetId ? ` · ${item.targetId.slice(0, 8)}` : ''}` : '—'}</td>
                    <td className="whitespace-nowrap text-xs text-ink-faint">{formatRelative(item.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
