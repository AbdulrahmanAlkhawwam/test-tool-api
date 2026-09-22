-- CreateEnum
CREATE TYPE "ReviewState" AS ENUM ('APPROVED', 'AI_DRAFT');

-- CreateEnum
CREATE TYPE "CreatedVia" AS ENUM ('WEB', 'IMPORT', 'AI');

-- CreateEnum
CREATE TYPE "SuggestionStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ApiTokenPurpose" AS ENUM ('MCP');

-- AlterTable
ALTER TABLE "TestCase" ADD COLUMN     "approvedAt" TIMESTAMP(3),
ADD COLUMN     "approvedById" TEXT,
ADD COLUMN     "createdVia" "CreatedVia" NOT NULL DEFAULT 'WEB',
ADD COLUMN     "reviewState" "ReviewState" NOT NULL DEFAULT 'APPROVED';

-- CreateTable
CREATE TABLE "TestCaseSuggestion" (
    "id" TEXT NOT NULL,
    "testCaseId" TEXT NOT NULL,
    "changes" JSONB NOT NULL,
    "status" "SuggestionStatus" NOT NULL DEFAULT 'PENDING',
    "rationale" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "TestCaseSuggestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "purpose" "ApiTokenPurpose" NOT NULL DEFAULT 'MCP',
    "tokenHash" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApiToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TestCaseSuggestion_testCaseId_status_idx" ON "TestCaseSuggestion"("testCaseId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ApiToken_tokenHash_key" ON "ApiToken"("tokenHash");

-- CreateIndex
CREATE INDEX "ApiToken_userId_idx" ON "ApiToken"("userId");

-- CreateIndex
CREATE INDEX "TestCase_projectId_reviewState_idx" ON "TestCase"("projectId", "reviewState");

-- AddForeignKey
ALTER TABLE "TestCase" ADD CONSTRAINT "TestCase_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestCaseSuggestion" ADD CONSTRAINT "TestCaseSuggestion_testCaseId_fkey" FOREIGN KEY ("testCaseId") REFERENCES "TestCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestCaseSuggestion" ADD CONSTRAINT "TestCaseSuggestion_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestCaseSuggestion" ADD CONSTRAINT "TestCaseSuggestion_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiToken" ADD CONSTRAINT "ApiToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
