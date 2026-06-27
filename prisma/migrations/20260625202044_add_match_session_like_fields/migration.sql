-- AlterTable
ALTER TABLE "MatchSession" ADD COLUMN     "userALiked" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "userBLiked" BOOLEAN NOT NULL DEFAULT false;
