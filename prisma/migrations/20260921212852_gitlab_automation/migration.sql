-- CreateEnum
CREATE TYPE "GitlabConnectionState" AS ENUM ('ACTIVE', 'NEEDS_RECONNECT');

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "defaultBranch" TEXT,
ADD COLUMN     "gitlabPath" TEXT,
ADD COLUMN     "gitlabProjectId" INTEGER,
ADD COLUMN     "gitlabWebUrl" TEXT,
ADD COLUMN     "playwrightConfigPath" TEXT,
ADD COLUMN     "testsPath" TEXT;

-- AlterTable
ALTER TABLE "TestResult" ADD COLUMN     "artifactsUrl" TEXT,
ADD COLUMN     "file" TEXT;

-- AlterTable
ALTER TABLE "TestRun" ADD COLUMN     "branch" TEXT,
ADD COLUMN     "note" TEXT,
ADD COLUMN     "pipelineId" INTEGER,
ADD COLUMN     "pipelineStatus" TEXT,
ADD COLUMN     "pipelineWebUrl" TEXT,
ADD COLUMN     "triggeredById" TEXT;

-- CreateTable
CREATE TABLE "GitlabConnection" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "gitlabUserId" INTEGER NOT NULL,
    "username" TEXT NOT NULL,
    "avatarUrl" TEXT,
    "accessTokenEnc" TEXT NOT NULL,
    "refreshTokenEnc" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "state" "GitlabConnectionState" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GitlabConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GitlabOAuthState" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "stateHash" TEXT NOT NULL,
    "codeVerifierEnc" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GitlabOAuthState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GitlabConnection_userId_key" ON "GitlabConnection"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "GitlabOAuthState_stateHash_key" ON "GitlabOAuthState"("stateHash");

-- CreateIndex
CREATE INDEX "GitlabOAuthState_userId_idx" ON "GitlabOAuthState"("userId");

-- CreateIndex
CREATE INDEX "TestRun_type_status_idx" ON "TestRun"("type", "status");

-- AddForeignKey
ALTER TABLE "TestRun" ADD CONSTRAINT "TestRun_triggeredById_fkey" FOREIGN KEY ("triggeredById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GitlabConnection" ADD CONSTRAINT "GitlabConnection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GitlabOAuthState" ADD CONSTRAINT "GitlabOAuthState_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
