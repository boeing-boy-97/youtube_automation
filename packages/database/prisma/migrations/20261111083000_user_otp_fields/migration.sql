-- AlterTable
ALTER TABLE "User" ADD COLUMN     "otpMode" "OtpMode" NOT NULL DEFAULT 'OFF',
ADD COLUMN     "telegramChatId" TEXT,
ADD COLUMN     "telegramLinkedAt" TIMESTAMP(3);

