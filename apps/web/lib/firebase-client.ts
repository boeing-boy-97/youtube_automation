/**
 * Browser side of Firebase Auth.
 *
 * The SDK is imported dynamically so the login page stays ~2 kB for the common case and the
 * Firebase bundle is only fetched when someone actually clicks "Continue with Google".
 *
 * Only the *proving* step happens in the browser: Google signs the user in, Firebase hands back a
 * short-lived ID token, and that token is exchanged for a ClipForge session cookie by the API.
 * The Firebase session is then signed out, so this app has exactly one source of truth for
 * "who is logged in" — the httpOnly cookie — instead of two that can disagree.
 */

export interface FirebaseWebConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  appId: string | null;
}

export class GoogleSignInError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

const MESSAGES: Record<string, string> = {
  'auth/popup-closed-by-user': 'The Google window was closed before finishing. Try again.',
  'auth/cancelled-popup-request': 'Another Google sign-in window is already open.',
  'auth/popup-blocked': 'Your browser blocked the Google pop-up. Allow pop-ups for this site and retry.',
  'auth/unauthorized-domain':
    'This domain is not authorised in the Firebase project. Add it under Authentication → Settings → Authorized domains.',
  'auth/operation-not-allowed':
    'Google sign-in is not enabled for this Firebase project. Enable it under Authentication → Sign-in method.',
  'auth/network-request-failed': 'Could not reach Google. Check your connection and try again.',
  'auth/invalid-api-key':
    'The Firebase web API key is wrong. Re-copy FIREBASE_WEB_API_KEY from Firebase → Project settings → General → Your apps.',
  'auth/configuration-not-found':
    'Firebase does not recognise this project configuration. Check FIREBASE_WEB_PROJECT_ID/FIREBASE_WEB_APP_ID, then restart the API.',
  'auth/account-exists-with-different-credential':
    'That email already uses a different sign-in method. Use the method you signed up with.',
};

/** Runs the Google popup flow and returns a Firebase ID token. */
export async function signInWithGoogle(config: FirebaseWebConfig): Promise<string> {
  let auth: Awaited<ReturnType<typeof loadAuth>>;
  try {
    auth = await loadAuth(config);
  } catch (error) {
    throw new GoogleSignInError(`Could not start Google sign-in: ${(error as Error).message}`, 'auth/initialisation-failed');
  }

  const { GoogleAuthProvider, signInWithPopup, signOut } = await import('firebase/auth');
  const provider = new GoogleAuthProvider();
  // Always let the user pick: shared machines must not silently reuse the last Google account.
  provider.setCustomParameters({ prompt: 'select_account' });

  try {
    const credential = await signInWithPopup(auth.auth, provider);
    const idToken = await credential.user.getIdToken();
    await signOut(auth.auth).catch(() => undefined);
    return idToken;
  } catch (error) {
    const code = (error as { code?: string }).code ?? 'auth/unknown';
    // Firebase ships several spellings for the same mistake (v11 appends a sentence to the code).
    const known = MESSAGES[code] ?? (code.startsWith('auth/api-key-not-valid') ? MESSAGES['auth/invalid-api-key'] : undefined);
    throw new GoogleSignInError(known ?? (error as Error).message ?? 'Google sign-in failed', code);
  }
}

let cached: { key: string; auth: Awaited<ReturnType<typeof buildAuth>> } | null = null;

async function buildAuth(config: FirebaseWebConfig) {
  const { initializeApp, getApps, getApp } = await import('firebase/app');
  const { getAuth, setPersistence, browserLocalPersistence } = await import('firebase/auth');
  const name = `clipforge-${config.projectId}-${config.appId ?? config.apiKey.slice(0, 8)}`;
  const existing = getApps().find((app) => app.name === name);
  const app = existing ?? initializeApp({ ...config, appId: config.appId ?? undefined }, name);
  const auth = getAuth(getApp(app.name));
  await setPersistence(auth, browserLocalPersistence);
  return { app: getApp(app.name), auth };
}

async function loadAuth(config: FirebaseWebConfig) {
  const key = `${config.projectId}:${config.apiKey}`;
  if (cached?.key === key) return cached.auth;
  const auth = await buildAuth(config);
  cached = { key, auth };
  return auth;
}
