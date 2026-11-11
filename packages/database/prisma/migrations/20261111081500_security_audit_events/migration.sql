-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'AUTH_OTP_CHALLENGE';
ALTER TYPE "AuditAction" ADD VALUE 'AUTH_OTP_VERIFIED';
ALTER TYPE "AuditAction" ADD VALUE 'AUTH_PASSWORD_RESET_REQUESTED';
ALTER TYPE "AuditAction" ADD VALUE 'AUTH_PASSWORD_RESET';
ALTER TYPE "AuditAction" ADD VALUE 'AUTH_SESSION_REVOKED';
ALTER TYPE "AuditAction" ADD VALUE 'AUTH_TELEGRAM_LINKED';
ALTER TYPE "AuditAction" ADD VALUE 'AUTH_RECOVERY_CODE_USED';
ALTER TYPE "AuditAction" ADD VALUE 'AUTH_SECURITY_ALERT';

-- AlterEnum
ALTER TYPE "NotificationCategory" ADD VALUE 'SECURITY_ALERT';

