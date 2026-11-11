import { Module } from '@nestjs/common';
import { EmailService } from '../common/services/email.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { FirebaseService } from './firebase.service';
import { OtpService } from './otp.service';
import { SecurityController } from './security.controller';
import { SecurityService } from './security.service';
import { SessionService } from './session.service';

/**
 * `NotificationsModule` is imported for security alerts: a new-device sign-in is delivered through
 * the same channel, dedupe and retry machinery as every other notification, rather than through a
 * second, parallel delivery path that would drift.
 */
@Module({
  imports: [NotificationsModule],
  controllers: [AuthController, SecurityController],
  providers: [
    AuthService,
    SessionService,
    FirebaseService,
    OtpService,
    SecurityService,
    // Configuration is read once from the environment at boot; a value provider keeps Nest from
    // trying to construct the class through its own injector (its constructor takes SMTP options).
    { provide: EmailService, useValue: new EmailService() },
  ],
  exports: [SessionService, AuthService, FirebaseService, SecurityService],
})
export class AuthModule {}
