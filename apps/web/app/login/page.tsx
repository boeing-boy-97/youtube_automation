'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useBootstrap, useLogin, useRegister, useSession } from '@/lib/hooks';
import { Card, Field } from '@/components/ui';
import { BackendDown } from '@/components/backend-down';

export default function LoginPage() {
  const router = useRouter();
  const login = useLogin();
  const bootstrap = useBootstrap();
  const register = useRegister();
  const session = useSession();
  // Self-registration is a server-side capability, not a client preference.
  const canRegister = session.data?.selfRegistrationEnabled === true;
  const [mode, setMode] = useState<'login' | 'bootstrap' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [workspaceName, setWorkspaceName] = useState('');
  const [bootstrapToken, setBootstrapToken] = useState('');
  const error = login.error ?? bootstrap.error ?? register.error;
  // No API means no login: show the deployment diagnosis rather than a form that cannot succeed.
  if (session.error) return <BackendDown message={session.error.message} onRetry={() => void session.refetch()} />;

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (mode === 'login') {
      login.mutate({ email, password }, { onSuccess: () => router.replace('/') });
    } else if (mode === 'register') {
      register.mutate(
        { email, password, displayName, workspaceName },
        { onSuccess: () => router.replace('/') },
      );
    } else {
      bootstrap.mutate(
        { bootstrapToken, email, password, displayName, workspaceName },
        { onSuccess: () => router.replace('/settings') },
      );
    }
  };

  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-surface-muted px-4 py-8 sm:py-12">
      <div className="w-full max-w-[420px]">
        <div className="mb-6 flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-ink text-sm font-bold text-white">CF</span>
          <div>
            <p className="text-[15px] font-semibold tracking-tight">ClipForge AI</p>
            <p className="text-xs text-ink-faint">AI video repurposing & automatic publishing</p>
          </div>
        </div>
        <Card className="p-6">
          <div className="mb-5 flex gap-1 rounded-lg bg-surface-sunken p-1 text-[13px]">
            {(canRegister ? (['login', 'register', 'bootstrap'] as const) : (['login', 'bootstrap'] as const)).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setMode(value)}
                className={`flex-1 rounded-md px-3 py-1.5 font-medium transition ${mode === value ? 'bg-white text-ink shadow-card' : 'text-ink-soft'}`}
              >
                {value === 'login' ? 'Sign in' : value === 'register' ? 'Create account' : 'First-run setup'}
              </button>
            ))}
          </div>
          <form onSubmit={submit} className="space-y-3.5">
            {mode === 'bootstrap' || mode === 'register' ? (
              <>
                {mode === 'bootstrap' ? (
                  <Field label="Bootstrap token" hint="ADMIN_BOOTSTRAP_TOKEN from the server environment" required>
                    <input className="input" value={bootstrapToken} onChange={(event) => setBootstrapToken(event.target.value)} required />
                  </Field>
                ) : null}
                <Field label="Your name" required>
                  <input className="input" value={displayName} onChange={(event) => setDisplayName(event.target.value)} required />
                </Field>
                <Field label="Workspace name" required>
                  <input className="input" value={workspaceName} onChange={(event) => setWorkspaceName(event.target.value)} required />
                </Field>
              </>
            ) : null}
            <Field label="Email" required>
              <input className="input" type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
            </Field>
            <Field label="Password" hint={mode === 'bootstrap' ? 'Minimum 12 characters with upper, lower and a digit' : undefined} required>
              <input className="input" type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} value={password} onChange={(event) => setPassword(event.target.value)} required />
            </Field>
            {error ? <p className="rounded-lg bg-danger-soft px-3 py-2 text-[13px] text-danger">{error.message}</p> : null}
            <button className="btn-primary w-full" type="submit" disabled={login.isPending || bootstrap.isPending || register.isPending}>
              {login.isPending || bootstrap.isPending || register.isPending
                ? 'Working…'
                : mode === 'login'
                  ? 'Sign in'
                  : mode === 'register'
                    ? 'Create account'
                    : 'Create administrator'}
            </button>
          </form>
        </Card>
        <p className="mt-4 text-center text-xs text-ink-faint">
          No default account exists. The first administrator is created with the one-time bootstrap token.
          {canRegister ? ' Self-service signup is enabled on this deployment.' : ''}
        </p>
      </div>
    </div>
  );
}
