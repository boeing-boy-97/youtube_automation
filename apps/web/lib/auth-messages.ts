import { ApiError } from './api';

/**
 * Users should read what to do, not what threw. Every branch below is a state this deployment can
 * actually reach — the codes come from the API and the proxy, not from imagination.
 */
export function describeAuthError(error: unknown): { title: string; message: string; hint?: string } {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'UNAUTHENTICATED':
        return { title: 'Sign-in failed', message: 'That email and password do not match an active account.' };
      case 'FORBIDDEN':
        return { title: 'Not allowed', message: error.message };
      case 'EMAIL_NOT_VERIFIED':
        return { title: 'Email not verified', message: error.message, hint: 'Verify the address with Google, then sign in again.' };
      case 'INVALID_ID_TOKEN':
        return { title: 'Google sign-in rejected', message: error.message };
      case 'FIREBASE_NOT_CONFIGURED':
        return {
          title: 'Google sign-in is not configured',
          message: 'This API has no Firebase service account, so it cannot verify Google accounts.',
          hint: 'Set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY, then restart the API. See docs/FIREBASE-AUTH.md.',
        };
      case 'CSRF_FAILED':
        return {
          title: 'Request blocked by origin check',
          message: 'The API rejected this page’s origin, so nothing was saved.',
          hint: 'Set APP_URL and ALLOWED_ORIGINS on the API to this exact origin (scheme + host, no trailing slash).',
        };
      case 'CONFLICT':
        return { title: 'Already exists', message: error.message };
      case 'BACKEND_UNREACHABLE':
        return { title: 'API unreachable', message: error.message, hint: 'Check /healthz to see which API origin this build points at.' };
      case 'RATE_LIMITED':
      case 'TOO_MANY_REQUESTS':
        return { title: 'Too many attempts', message: 'Wait a few minutes before trying again.' };
      default:
        return { title: 'Something went wrong', message: error.message };
    }
  }
  if (error instanceof Error) return { title: 'Something went wrong', message: error.message };
  return { title: 'Something went wrong', message: 'An unexpected error occurred.' };
}

/** Client-side checks that mirror the API schema, so obvious mistakes never cost a round trip. */
export function validateCredentials(email: string, password: string, mode: 'login' | 'register' | 'bootstrap') {
  const errors: { email?: string; password?: string } = {};
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) errors.email = 'Enter a valid email address.';
  if (mode !== 'login') {
    if (password.length < 12) errors.password = 'At least 12 characters.';
    else if (!/[a-z]/.test(password)) errors.password = 'Add a lowercase letter.';
    else if (!/[A-Z]/.test(password)) errors.password = 'Add an uppercase letter.';
    else if (!/[0-9]/.test(password)) errors.password = 'Add a digit.';
  } else if (password.length === 0) {
    errors.password = 'Enter your password.';
  }
  return errors;
}
