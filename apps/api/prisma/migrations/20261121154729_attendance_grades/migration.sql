-- AlterTable
ALTER TABLE "Attendance" ADD COLUMN     "charged" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "comment" TEXT,
ADD COLUMN     "markedById" TEXT;

-- AlterTable
ALTER TABLE "Grade" ADD COLUMN     "createdById" TEXT,
ADD COLUMN     "maxValue" DECIMAL(6,2);

-- AlterTable
ALTER TABLE "Lesson" ADD COLUMN     "courseTopicId" TEXT;

-- CreateTable
CREATE TABLE "CourseTopic" (
    "id" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "sort" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "chapter" TEXT,

    CONSTRAINT "CourseTopic_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Setting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Setting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "studentId" TEXT,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CourseTopic_courseId_sort_idx" ON "CourseTopic"("courseId", "sort");

-- CreateIndex
CREATE INDEX "Notification_status_createdAt_idx" ON "Notification"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Grade_studentId_skill_idx" ON "Grade"("studentId", "skill");

-- AddForeignKey
ALTER TABLE "CourseTopic" ADD CONSTRAINT "CourseTopic_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lesson" ADD CONSTRAINT "Lesson_courseTopicId_fkey" FOREIGN KEY ("courseTopicId") REFERENCES "CourseTopic"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Grade" ADD CONSTRAINT "Grade_lessonId_fkey" FOREIGN KEY ("lessonId") REFERENCES "Lesson"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
