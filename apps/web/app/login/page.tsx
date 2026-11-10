'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { BackendDown } from '@/components/backend-down';
import { GoogleSignInButton } from '@/components/google-button';
import { Card, Field } from '@/components/ui';
import { describeAuthError, validateCredentials } from '@/lib/auth-messages';
import { GoogleSignInError, signInWithGoogle } from '@/lib/firebase-client';
import { useBootstrap, useFirebaseLogin, useLogin, useRegister, useSession, useSignInProviders } from '@/lib/hooks';

type Mode = 'login' | 'register' | 'bootstrap';

const TITLES: Record<Mode, { heading: string; sub: string; cta: string }> = {
  login: { heading: 'Sign in', sub: 'Use your ClipForge account.', cta: 'Sign in' },
  register: { heading: 'Create your workspace', sub: 'Self-service signup is enabled on this deployment.', cta: 'Create account' },
  bootstrap: { heading: 'First-run setup', sub: 'Create the first administrator with the one-time bootstrap token.', cta: 'Create administrator' },
};

export default function LoginPage() {
  const router = useRouter();
  const login = useLogin();
  const bootstrap = useBootstrap();
  const register = useRegister();
  const firebaseLogin = useFirebaseLogin();
  const session = useSession();
  const providers = useSignInProviders();

  const canRegister = session.data?.selfRegistrationEnabled === true || providers.data?.selfRegistrationEnabled === true;
  const google = providers.data?.firebase;
  const googleReady = Boolean(google?.enabled && google.config);

  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [workspaceName, setWorkspaceName] = useState('');
  const [bootstrapToken, setBootstrapToken] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [touched, setTouched] = useState<{ email?: boolean; password?: boolean }>({});
  const [googleError, setGoogleError] = useState<string | null>(null);

  const credentials = useMemo(() => validateCredentials(email, password, mode), [email, password, mode]);
  const submitted = login.isPending || register.isPending || bootstrap.isPending || firebaseLogin.isPending;
  const serverError = login.error ?? bootstrap.error ?? register.error ?? firebaseLogin.error;
  const failure = serverError ? describeAuthError(serverError) : null;

  // A session that already exists should not sit on the login screen.
  useEffect(() => {
    if (session.data?.authenticated) router.replace('/');
  }, [session.data?.authenticated, router]);

  // No API means no login: show the deployment diagnosis rather than a form that cannot succeed.
  if (session.error) return <BackendDown message={session.error.message} onRetry={() => void session.refetch()} />;

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setTouched({ email: true, password: true });
    if (Object.keys(credentials).length > 0) return;
    if (mode === 'login') {
      login.mutate({ email: email.trim(), password }, { onSuccess: () => router.replace('/') });
    } else if (mode === 'register') {
      register.mutate({ email: email.trim(), password, displayName: displayName.trim(), workspaceName: workspaceName.trim() }, { onSuccess: () => router.replace('/') });
    } else {
      bootstrap.mutate(
        { bootstrapToken: bootstrapToken.trim(), email: email.trim(), password, displayName: displayName.trim(), workspaceName: workspaceName.trim() },
        { onSuccess: () => router.replace('/settings') },
      );
    }
  };

  const withGoogle = async () => {
    if (!google?.config) return;
    setGoogleError(null);
    try {
      const idToken = await signInWithGoogle(google.config);
      firebaseLogin.mutate({ idToken }, { onSuccess: () => router.replace('/') });
    } catch (error) {
      setGoogleError(error instanceof GoogleSignInError ? error.message : (error as Error).message);
    }
  };

  const fieldError = (key: 'email' | 'password') => (touched[key] ? credentials[key] : undefined);

  return (
    <div className="flex min-h-[100dvh] flex-col bg-surface-muted lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
      {/* Product panel — decorative, hidden on small screens where the form is the whole job. */}
      <aside className="relative hidden overflow-hidden bg-ink px-10 py-12 text-white lg:flex lg:flex-col lg:justify-between">
        <div
          className="pointer-events-none absolute inset-0 opacity-[0.16]"
          style={{
            backgroundImage:
              'radial-gradient(circle at 20% 15%, #6b7bff 0, transparent 45%), radial-gradient(circle at 85% 80%, #22d3a7 0, transparent 40%)',
          }}
        />
        <div className="relative">
          <div className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-white text-sm font-bold text-ink">CF</span>
            <span className="text-[15px] font-semibold tracking-tight">ClipForge AI</span>
          </div>
          <h1 className="mt-14 max-w-[15ch] text-[34px] font-semibold leading-[1.1] tracking-tight">
            Long videos in. Vertical clips out.
          </h1>
          <p className="mt-4 max-w-[38ch] text-[14px] leading-relaxed text-white/70">
            Transcription, highlight selection, rendering and scheduled publishing — one pipeline, measured end to end.
          </p>
          <ul className="mt-10 space-y-3 text-[13px] text-white/75">
            {['Upload once, get 30s / 60s / 90s cuts', 'Burned-in captions from the real transcript', 'Publish to YouTube and Instagram on a schedule'].map((item) => (
              <li key={item} className="flex items-start gap-2.5">
                <svg className="mt-0.5 h-4 w-4 shrink-0 text-white/50" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                  <path fillRule="evenodd" d="M16.7 5.3a1 1 0 0 1 0 1.4l-7.5 7.5a1 1 0 0 1-1.4 0L3.3 10.7a1 1 0 1 1 1.4-1.4l3.8 3.8 6.8-6.8a1 1 0 0 1 1.4 0Z" clipRule="evenodd" />
                </svg>
                {item}
              </li>
            ))}
          </ul>
        </div>
        <p className="relative text-[11px] text-white/40">
          Sessions are httpOnly cookies with CSRF protection. No tokens are kept in localStorage.
        </p>
      </aside>

      <main className="flex flex-1 items-center justify-center px-4 py-8 sm:px-8 sm:py-12">
        <div className="w-full max-w-[420px]">
          <div className="mb-6 flex items-center gap-2.5 lg:hidden">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-ink text-sm font-bold text-white">CF</span>
            <div>
              <p className="text-[15px] font-semibold tracking-tight text-ink">ClipForge AI</p>
              <p className="text-xs text-ink-faint">AI video repurposing &amp; automatic publishing</p>
            </div>
          </div>

          <Card className="p-5 sm:p-6">
            <div className="mb-5">
              <h2 className="text-[19px] font-semibold tracking-tight text-ink">{TITLES[mode].heading}</h2>
              <p className="mt-1 text-[13px] text-ink-soft">{TITLES[mode].sub}</p>
            </div>

            {mode === 'login' ? (
              <>
                <GoogleSignInButton onClick={withGoogle} pending={firebaseLogin.isPending} disabled={!googleReady || submitted} />
                {!googleReady && providers.data ? (
                  <p className="mt-2 text-[11.5px] leading-relaxed text-ink-faint">
                    {google?.error
                      ? `Google sign-in unavailable: ${google.error}`
                      : 'Google sign-in is not enabled on this deployment — use your email and password below.'}
                  </p>
                ) : null}
                {googleError ? (
                  <p role="alert" className="mt-2 rounded-lg bg-danger-soft px-3 py-2 text-[12.5px] text-danger">
                    {googleError}
                  </p>
                ) : null}
                <div className="my-5 flex items-center gap-3">
                  <span className="h-px flex-1 bg-line" />
                  <span className="text-[11px] font-medium uppercase tracking-wide text-ink-faint">or with email</span>
                  <span className="h-px flex-1 bg-line" />
                </div>
              </>
            ) : null}

            <form onSubmit={submit} className="space-y-3.5" noValidate>
              {mode !== 'login' ? (
                <>
                  {mode === 'bootstrap' ? (
                    <Field label="Bootstrap token" hint="ADMIN_BOOTSTRAP_TOKEN from the API environment" required>
                      <input
                        className="input font-mono text-[12.5px]"
                        value={bootstrapToken}
                        onChange={(event) => setBootstrapToken(event.target.value)}
                        autoComplete="off"
                        required
                      />
                    </Field>
                  ) : null}
                  <div className="grid gap-3.5 sm:grid-cols-2">
                    <Field label="Your name" required>
                      <input className="input" value={displayName} onChange={(event) => setDisplayName(event.target.value)} autoComplete="name" required />
                    </Field>
                    <Field label="Workspace name" required>
                      <input className="input" value={workspaceName} onChange={(event) => setWorkspaceName(event.target.value)} autoComplete="organization" required />
                    </Field>
                  </div>
                </>
              ) : null}

              <Field label="Email" required>
                <input
                  className="input"
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  autoCapitalize="none"
                  spellCheck={false}
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  onBlur={() => setTouched((state) => ({ ...state, email: true }))}
                  aria-invalid={Boolean(fieldError('email'))}
                  aria-describedby={fieldError('email') ? 'email-error' : undefined}
                  disabled={submitted}
                  required
                />
                {fieldError('email') ? (
                  <p id="email-error" className="mt-1 text-[12px] text-danger">
                    {fieldError('email')}
                  </p>
                ) : null}
              </Field>

              <Field label="Password" hint={mode === 'login' ? undefined : 'At least 12 characters with upper, lower and a digit'} required>
                <div className="relative">
                  <input
                    className="input pr-11"
                    type={showPassword ? 'text' : 'password'}
                    autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    onBlur={() => setTouched((state) => ({ ...state, password: true }))}
                    aria-invalid={Boolean(fieldError('password'))}
                    aria-describedby={fieldError('password') ? 'password-error' : undefined}
                    disabled={submitted}
                    required
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((value) => !value)}
                    className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-ink-faint transition hover:text-ink"
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    tabIndex={-1}
                  >
                    {showPassword ? (
                      <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                        <path d="M3 3l18 18M10.6 10.6a2 2 0 0 0 2.8 2.8" strokeLinecap="round" />
                        <path d="M6.5 6.7C4.6 8.3 3.2 10.4 2.5 12c1.5 3.2 5.2 6 9.5 6 1.8 0 3.4-.5 4.8-1.3M17.6 17.1c1.9-1.6 3.3-3.6 3.9-5.1-1.5-3.2-5.2-6-9.5-6-.6 0-1.2.1-1.7.2" strokeLinecap="round" />
                      </svg>
                    ) : (
                      <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                        <path d="M2.5 12C4 8.8 7.7 6 12 6s8 2.8 9.5 6c-1.5 3.2-5.2 6-9.5 6s-8-2.8-9.5-6Z" />
                        <circle cx="12" cy="12" r="2.6" />
                      </svg>
                    )}
                  </button>
                </div>
                {fieldError('password') ? (
                  <p id="password-error" className="mt-1 text-[12px] text-danger">
                    {fieldError('password')}
                  </p>
                ) : null}
              </Field>

              {failure ? (
                <div role="alert" className="rounded-lg bg-danger-soft px-3 py-2.5">
                  <p className="text-[12.5px] font-semibold text-danger">{failure.title}</p>
                  <p className="mt-0.5 text-[12.5px] leading-relaxed text-danger">{failure.message}</p>
                  {failure.hint ? <p className="mt-1 text-[11.5px] leading-relaxed text-danger/80">{failure.hint}</p> : null}
                </div>
              ) : null}

              <button className="btn-primary w-full" type="submit" disabled={submitted}>
                {submitted ? (
                  <span className="flex items-center justify-center gap-2">
                    <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/30 border-t-white" aria-hidden="true" />
                    Working…
                  </span>
                ) : (
                  TITLES[mode].cta
                )}
              </button>
            </form>

            {/* Always reachable: with self-registration closed, first-run setup is the only way in
                on a fresh deployment, so it must never disappear from the sign-in screen. */}
            <div className="mt-4 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-line pt-3.5 text-[12.5px]">
              <span className="text-ink-faint">
                {mode === 'login' ? (canRegister ? 'No account yet?' : 'No account?') : 'Already have an account?'}
              </span>
              <div className="flex gap-3">
                {mode !== 'login' ? (
                  <button type="button" className="font-medium text-accent hover:underline" onClick={() => setMode('login')}>
                    Sign in
                  </button>
                ) : canRegister ? (
                  <button type="button" className="font-medium text-accent hover:underline" onClick={() => setMode('register')}>
                    Create account
                  </button>
                ) : null}
                {mode !== 'bootstrap' ? (
                  <button type="button" className="font-medium text-ink-soft hover:text-ink hover:underline" onClick={() => setMode('bootstrap')}>
                    First-run setup
                  </button>
                ) : null}
              </div>
            </div>
          </Card>

          <p className="mt-4 text-center text-[11px] leading-relaxed text-ink-faint">
            {googleReady ? 'Google sign-in is verified server-side; the token never becomes your session.' : 'Signing in with email and password.'}{' '}
            <a className="underline hover:text-ink-soft" href="/healthz">
              Deployment status
            </a>
          </p>
        </div>
      </main>
    </div>
  );
}
