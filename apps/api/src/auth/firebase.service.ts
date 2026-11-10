import { Injectable, Logger, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { applicationDefault, cert, getApps, initializeApp, type App } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { env } from '../common/env';

/** What the API trusts after verifying a Firebase ID token. */
export interface FirebaseIdentity {
  uid: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
  picture: string | null;
  signInProvider: string;
}

/** Public web config the browser needs to start the SDK. Safe to expose — it ships in every site. */
export interface FirebaseWebConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  appId: string | null;
}

/**
 * Verifies Firebase ID tokens for the API.
 *
 * Two deliberate choices:
 *  - Verification happens server-side with a service account. The browser's `email` claim is never
 *    trusted; only a signature-checked token issued for this project is.
 *  - Firebase only replaces the *proving* step. The session that follows is still the httpOnly
 *    cookie issued by SessionService, so every existing guard, CSRF check and audit log keeps
 *    working exactly as it did for password logins.
 */
@Injectable()
export class FirebaseService {
  private readonly logger = new Logger('FirebaseAuth');
  private app: App | null = null;
  private initError: string | null = null;
  private initialized = false;

  private serviceAccount(): Record<string, string> | null {
    if (env.FIREBASE_SERVICE_ACCOUNT_JSON) {
      try {
        const parsed = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON) as Record<string, string>;
        if (parsed.private_key) parsed.private_key = parsed.private_key.replace(/\\n/g, '\n');
        return parsed;
      } catch {
        this.initError = 'FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON';
        return null;
      }
    }
    if (env.FIREBASE_PROJECT_ID && env.FIREBASE_CLIENT_EMAIL && env.FIREBASE_PRIVATE_KEY) {
      return {
        project_id: env.FIREBASE_PROJECT_ID,
        client_email: env.FIREBASE_CLIENT_EMAIL,
        // .env files cannot hold real newlines; accept both the escaped and the literal form.
        private_key: env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      };
    }
    return null;
  }

  /** True when the server can verify tokens. Never throws — the login page asks this often. */
  get configured(): boolean {
    if (!this.initialized) this.init();
    return this.app !== null;
  }

  get configurationError(): string | null {
    if (!this.initialized) this.init();
    return this.initError;
  }

  private init(): void {
    this.initialized = true;
    const account = this.serviceAccount();
    try {
      if (account) {
        this.app = getApps()[0] ?? initializeApp({ credential: cert(account as Parameters<typeof cert>[0]) });
      } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
        this.app = getApps()[0] ?? initializeApp({ credential: applicationDefault() });
      }
    } catch (error) {
      this.initError = (error as Error).message;
      this.app = null;
    }
    if (this.initError) this.logger.error(`Firebase Auth is configured but unusable: ${this.initError}`);
    else if (this.app) this.logger.log('Firebase ID token verification is enabled');
  }

  /** The browser-side config, or null when this deployment has no Firebase web app. */
  webConfig(): FirebaseWebConfig | null {
    const account = this.serviceAccount();
    const projectId = env.FIREBASE_PROJECT_ID ?? account?.project_id ?? null;
    const apiKey = env.FIREBASE_WEB_API_KEY ?? null;
    if (!apiKey || !projectId) return null;
    return {
      apiKey,
      authDomain: env.FIREBASE_WEB_AUTH_DOMAIN ?? `${projectId}.firebaseapp.com`,
      projectId,
      appId: env.FIREBASE_WEB_APP_ID ?? null,
    };
  }

  async verifyIdToken(idToken: string): Promise<FirebaseIdentity> {
    if (!this.configured || !this.app) {
      throw new ServiceUnavailableException({
        code: 'FIREBASE_NOT_CONFIGURED',
        message:
          this.initError ??
          'Google sign-in is not configured on this API. Set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY, then restart.',
      });
    }
    try {
      // checkRevoked: a disabled or deleted Firebase user must lose access immediately, not when
      // their hour-long ID token happens to expire.
      const decoded = await getAuth(this.app).verifyIdToken(idToken, true);
      return {
        uid: decoded.uid,
        email: typeof decoded.email === 'string' ? decoded.email.toLowerCase() : null,
        emailVerified: decoded.email_verified === true,
        name: typeof decoded.name === 'string' ? decoded.name : null,
        picture: typeof decoded.picture === 'string' ? decoded.picture : null,
        signInProvider: decoded.firebase?.sign_in_provider ?? 'unknown',
      };
    } catch (error) {
      throw new UnauthorizedException({
        code: 'INVALID_ID_TOKEN',
        message: `Google sign-in was rejected: ${(error as Error).message}`,
      });
    }
  }
}
