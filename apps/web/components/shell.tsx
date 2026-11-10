'use client';

import clsx from 'clsx';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useLogout, useSession } from '@/lib/hooks';
import { BackendDown } from './backend-down';
import { Badge } from './ui';

type NavItem = { href: string; label: string; short: string; icon: string };

const NAV: NavItem[] = [
  { href: '/', label: 'Dashboard', short: 'Home', icon: 'M3 12h6v9H3zM10 3h4v18h-4zM15 8h6v13h-6z' },
  { href: '/create', label: 'Create project', short: 'Create', icon: 'M12 5v14M5 12h14' },
  { href: '/jobs', label: 'Processing', short: 'Jobs', icon: 'M12 6v6l4 2M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z' },
  { href: '/clips', label: 'Clip library', short: 'Clips', icon: 'M4 5h16v14H4zM9 9l6 3-6 3z' },
  { href: '/publishing', label: 'Publishing', short: 'Publish', icon: 'M4 12l16-8-6 16-3-6z' },
  { href: '/accounts', label: 'Connected accounts', short: 'Accounts', icon: 'M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0zM4 21a8 8 0 0 1 16 0' },
  { href: '/brand', label: 'Brand studio', short: 'Brand', icon: 'M12 3l2.6 5.6 6.1.8-4.4 4.3 1.1 6-5.4-3-5.4 3 1.1-6L3.3 9.4l6.1-.8z' },
  { href: '/settings', label: 'Settings', short: 'Settings', icon: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19 12a7 7 0 0 0-.1-1.2l2-1.5-2-3.4-2.3 1a7 7 0 0 0-2-1.2L14 3h-4l-.6 2.7a7 7 0 0 0-2 1.2l-2.3-1-2 3.4 2 1.5A7 7 0 0 0 5 12c0 .4 0 .8.1 1.2l-2 1.5 2 3.4 2.3-1a7 7 0 0 0 2 1.2L10 21h4l.6-2.7a7 7 0 0 0 2-1.2l2.3 1 2-3.4-2-1.5c.1-.4.1-.8.1-1.2z' },
  { href: '/activity', label: 'Activity log', short: 'Activity', icon: 'M4 6h16M4 12h16M4 18h10' },
  { href: '/admin', label: 'System admin', short: 'Admin', icon: 'M12 3l8 4v5c0 5-3.4 8.3-8 9-4.6-.7-8-4-8-9V7z' },
];

/** Routes shown in the phone bottom bar; everything else lives behind "More". */
const BOTTOM_BAR = ['/', '/create', '/jobs', '/clips'];

const isActive = (href: string, pathname: string) => (href === '/' ? pathname === '/' : pathname.startsWith(href));

function NavIcon({ d, active }: { d: string; active: boolean }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={active ? 2 : 1.7}
      strokeLinecap="round"
      aria-hidden="true"
      className="shrink-0"
    >
      <path d={d} />
    </svg>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const sessionQuery = useSession();
  const { data: session, isLoading } = sessionQuery;
  const logout = useLogout();

  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!isLoading && !sessionQuery.isFetching && session && !session.authenticated && pathname !== '/login') {
      router.replace('/login');
    }
  }, [isLoading, sessionQuery.isFetching, session, router, pathname]);

  // The drawer is a modal surface: close on navigation, Escape, and lock background scroll while open.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        close();
        menuButtonRef.current?.focus();
        return;
      }
      if (event.key !== 'Tab' || !panelRef.current) return;
      // Keep focus inside the drawer.
      const focusable = panelRef.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled])');
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    closeRef.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, close]);

  if (pathname === '/login') return <>{children}</>;
  if (isLoading) {
    return (
      <div className="grid min-h-[100dvh] place-items-center p-6 text-center text-sm text-ink-soft">
        Checking your session…
      </div>
    );
  }
  if (!session?.authenticated) {
    // A failed session probe is not "signed out": with no API the login form could never succeed
    // either, so say what is actually broken.
    if (sessionQuery.error) {
      return <BackendDown message={sessionQuery.error.message} onRetry={() => void sessionQuery.refetch()} />;
    }
    return <div className="grid min-h-[100dvh] place-items-center p-6 text-center text-sm text-ink-soft">Redirecting to sign in…</div>;
  }

  const missing = session.configuration?.missing ?? [];
  const processingReady = session.configuration?.processingReady ?? false;
  const isAdmin = ['OWNER', 'ADMIN'].includes(session.user?.role ?? '');
  const visibleNav = NAV.filter((item) => item.href !== '/admin' || isAdmin);
  const signOut = () => logout.mutate(undefined, { onSuccess: () => router.replace('/login') });
  const workspaceBlock = (
    <>
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-ink text-[13px] font-bold text-white">CF</span>
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold tracking-tight text-ink">ClipForge AI</p>
        <p className="truncate text-[11px] text-ink-faint">{session.workspace?.name}</p>
      </div>
    </>
  );

  return (
    <div className="flex min-h-[100dvh]">
      <aside className="sticky top-0 hidden h-[100dvh] w-[248px] shrink-0 flex-col border-r border-line bg-white lg:flex">
        <div className="flex items-center gap-2.5 px-5 py-5">{workspaceBlock}</div>
        <nav className="flex-1 space-y-0.5 overflow-y-auto px-3 pb-4" aria-label="Main">
          {visibleNav.map((item) => {
            const active = isActive(item.href, pathname);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={clsx(
                  'flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] font-medium transition',
                  active ? 'bg-accent-soft text-accent-strong' : 'text-ink-soft hover:bg-surface-muted hover:text-ink',
                )}
              >
                <NavIcon d={item.icon} active={active} />
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="border-t border-line px-4 py-4">
          <p className="truncate text-[13px] font-medium text-ink">{session.user?.displayName}</p>
          <p className="truncate text-xs text-ink-faint">{session.user?.email}</p>
          <button type="button" onClick={signOut} className="btn-ghost mt-2 w-full justify-start px-2 text-[13px]">
            Sign out
          </button>
        </div>
      </aside>

      {open ? (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button
            type="button"
            aria-label="Close navigation"
            onClick={close}
            className="cf-fade absolute inset-0 h-full w-full cursor-default bg-ink/40 backdrop-blur-sm"
          />
          <div
            ref={panelRef}
            id="mobile-nav"
            role="dialog"
            aria-modal="true"
            aria-label="Navigation"
            className="cf-drawer absolute inset-y-0 left-0 flex w-[86%] max-w-[320px] flex-col bg-white shadow-2xl"
            style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
          >
            <div className="flex items-center justify-between gap-2 px-4 py-4">
              <div className="flex min-w-0 items-center gap-2.5">{workspaceBlock}</div>
              <button
                ref={closeRef}
                type="button"
                onClick={close}
                aria-label="Close navigation"
                className="-mr-1 grid h-10 w-10 shrink-0 place-items-center rounded-lg text-ink-soft hover:bg-surface-muted"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </div>
            <nav className="flex-1 space-y-0.5 overflow-y-auto px-3 pb-4" aria-label="Main">
              {visibleNav.map((item) => {
                const active = isActive(item.href, pathname);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    aria-current={active ? 'page' : undefined}
                    onClick={close}
                    className={clsx(
                      'flex items-center gap-3 rounded-lg px-3 py-3 text-sm font-medium transition',
                      active ? 'bg-accent-soft text-accent-strong' : 'text-ink-soft hover:bg-surface-muted hover:text-ink',
                    )}
                  >
                    <NavIcon d={item.icon} active={active} />
                    {item.label}
                  </Link>
                );
              })}
            </nav>
            <div className="border-t border-line px-4 py-4">
              <p className="truncate text-sm font-medium text-ink">{session.user?.displayName}</p>
              <p className="truncate text-xs text-ink-faint">{session.user?.email}</p>
              <button type="button" onClick={signOut} className="btn-secondary mt-3 w-full">
                Sign out
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex items-center gap-3 border-b border-line bg-white/90 px-4 py-3 backdrop-blur sm:px-6">
          <button
            ref={menuButtonRef}
            type="button"
            onClick={() => setOpen(true)}
            aria-label="Open navigation"
            aria-expanded={open}
            aria-controls="mobile-nav"
            className="-ml-1 grid h-10 w-10 shrink-0 place-items-center rounded-lg text-ink-soft hover:bg-surface-muted lg:hidden"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
              <path d="M4 7h16M4 12h16M4 17h16" />
            </svg>
          </button>
          <div className="flex min-w-0 flex-1 items-center gap-2 sm:gap-3">
            <span className="truncate text-sm font-semibold text-ink lg:hidden">ClipForge AI</span>
            <Badge tone={processingReady ? 'positive' : 'caution'} className="shrink-0">
              <span className="hidden sm:inline">{processingReady ? 'Configuration complete' : 'Configuration required'}</span>
              <span className="sm:hidden">{processingReady ? 'Ready' : 'Setup'}</span>
            </Badge>
            {!processingReady && missing.length > 0 ? (
              <span className="hidden truncate text-xs text-ink-soft md:inline">
                {missing.length} setting(s) missing —{' '}
                <Link href="/settings" className="font-medium text-accent hover:underline">
                  finish setup
                </Link>
              </span>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-2 text-xs text-ink-faint">
            <span className="hidden lg:inline">{session.workspace?.timezone}</span>
            <Link href="/create" className="btn-primary !px-3 !py-1.5 text-[13px]">
              <span className="hidden sm:inline">New project</span>
              <span aria-hidden="true" className="sm:hidden">
                +
              </span>
              <span className="sr-only sm:hidden">New project</span>
            </Link>
          </div>
        </header>

        <main className="mx-auto w-full max-w-[1180px] flex-1 px-4 pb-24 pt-5 sm:px-6 sm:py-7 lg:pb-7">{children}</main>

        <nav
          aria-label="Quick navigation"
          className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-white/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden"
        >
          <div className="mx-auto flex max-w-md items-stretch">
            {visibleNav
              .filter((item) => BOTTOM_BAR.includes(item.href))
              .map((item) => {
                const active = isActive(item.href, pathname);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    aria-current={active ? 'page' : undefined}
                    className={clsx(
                      'flex min-h-[52px] flex-1 flex-col items-center justify-center gap-1 px-1 py-1.5 text-[11px] font-medium transition',
                      active ? 'text-accent-strong' : 'text-ink-faint hover:text-ink',
                    )}
                  >
                    <NavIcon d={item.icon} active={active} />
                    {item.short}
                  </Link>
                );
              })}
            <button
              type="button"
              onClick={() => setOpen(true)}
              aria-label="More destinations"
              className="flex min-h-[52px] flex-1 flex-col items-center justify-center gap-1 px-1 py-1.5 text-[11px] font-medium text-ink-faint transition hover:text-ink"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
                <path d="M5 12h.01M12 12h.01M19 12h.01" />
              </svg>
              More
            </button>
          </div>
        </nav>
      </div>
    </div>
  );
}
