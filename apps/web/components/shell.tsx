'use client';

import clsx from 'clsx';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { useLogout, useSession } from '@/lib/hooks';
import { Badge } from './ui';

const NAV: Array<{ href: string; label: string; icon: string }> = [
  { href: '/', label: 'Dashboard', icon: 'M3 12h6v9H3zM10 3h4v18h-4zM15 8h6v13h-6z' },
  { href: '/create', label: 'Create project', icon: 'M12 5v14M5 12h14' },
  { href: '/jobs', label: 'Processing', icon: 'M12 6v6l4 2M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z' },
  { href: '/clips', label: 'Clip library', icon: 'M4 5h16v14H4zM9 9l6 3-6 3z' },
  { href: '/publishing', label: 'Publishing', icon: 'M4 12l16-8-6 16-3-6z' },
  { href: '/accounts', label: 'Connected accounts', icon: 'M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0zM4 21a8 8 0 0 1 16 0' },
  { href: '/brand', label: 'Brand studio', icon: 'M12 3l2.6 5.6 6.1.8-4.4 4.3 1.1 6-5.4-3-5.4 3 1.1-6L3.3 9.4l6.1-.8z' },
  { href: '/settings', label: 'Settings', icon: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19 12a7 7 0 0 0-.1-1.2l2-1.5-2-3.4-2.3 1a7 7 0 0 0-2-1.2L14 3h-4l-.6 2.7a7 7 0 0 0-2 1.2l-2.3-1-2 3.4 2 1.5A7 7 0 0 0 5 12c0 .4 0 .8.1 1.2l-2 1.5 2 3.4 2.3-1a7 7 0 0 0 2 1.2L10 21h4l.6-2.7a7 7 0 0 0 2-1.2l2.3 1 2-3.4-2-1.5c.1-.4.1-.8.1-1.2z' },
  { href: '/activity', label: 'Activity log', icon: 'M4 6h16M4 12h16M4 18h10' },
  { href: '/admin', label: 'System admin', icon: 'M12 3l8 4v5c0 5-3.4 8.3-8 9-4.6-.7-8-4-8-9V7z' },
];

export function Shell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const sessionQuery = useSession();
  const { data: session, isLoading } = sessionQuery;
  const logout = useLogout();

  useEffect(() => {
    if (!isLoading && !sessionQuery.isFetching && session && !session.authenticated && pathname !== '/login') {
      router.replace('/login');
    }
  }, [isLoading, sessionQuery.isFetching, session, router, pathname]);

  if (pathname === '/login') return <>{children}</>;
  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-ink-soft">
        Checking your session…
      </div>
    );
  }
  if (!session?.authenticated) {
    return <div className="flex min-h-screen items-center justify-center text-sm text-ink-soft">Redirecting to sign in…</div>;
  }

  const missing = session.configuration?.missing ?? [];
  const processingReady = session.configuration?.processingReady ?? false;

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 hidden h-screen w-[248px] shrink-0 flex-col border-r border-line bg-white lg:flex">
        <div className="flex items-center gap-2.5 px-5 py-5">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-ink text-[13px] font-bold text-white">CF</span>
          <div>
            <p className="text-sm font-semibold tracking-tight text-ink">ClipForge AI</p>
            <p className="text-[11px] text-ink-faint">{session.workspace?.name}</p>
          </div>
        </div>
        <nav className="flex-1 space-y-0.5 px-3">
          {NAV.filter((item) => item.href !== '/admin' || ['OWNER', 'ADMIN'].includes(session.user?.role ?? '')).map((item) => {
            const active = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={clsx(
                  'flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] font-medium transition',
                  active ? 'bg-accent-soft text-accent-strong' : 'text-ink-soft hover:bg-surface-muted hover:text-ink',
                )}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
                  <path d={item.icon} />
                </svg>
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="border-t border-line px-4 py-4">
          <p className="truncate text-[13px] font-medium text-ink">{session.user?.displayName}</p>
          <p className="truncate text-xs text-ink-faint">{session.user?.email}</p>
          <button
            type="button"
            onClick={() => logout.mutate(undefined, { onSuccess: () => router.replace('/login') })}
            className="btn-ghost mt-2 w-full justify-start px-2 text-[13px]"
          >
            Sign out
          </button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex items-center justify-between gap-4 border-b border-line bg-white/90 px-6 py-3 backdrop-blur">
          <div className="flex items-center gap-3">
            <div className="lg:hidden text-sm font-semibold">ClipForge AI</div>
            <Badge tone={processingReady ? 'positive' : 'caution'}>
              {processingReady ? 'Configuration complete' : 'Configuration required'}
            </Badge>
            {!processingReady && missing.length > 0 ? (
              <span className="hidden text-xs text-ink-soft sm:inline">
                {missing.length} setting(s) missing —{' '}
                <Link href="/settings" className="font-medium text-accent hover:underline">
                  finish setup
                </Link>
              </span>
            ) : null}
          </div>
          <div className="flex items-center gap-2 text-xs text-ink-faint">
            <span className="hidden sm:inline">{session.workspace?.timezone}</span>
            <Link href="/create" className="btn-primary !px-3 !py-1.5 text-[13px]">
              New project
            </Link>
          </div>
        </header>
        <main className="mx-auto w-full max-w-[1180px] flex-1 px-6 py-7">{children}</main>
      </div>
    </div>
  );
}
