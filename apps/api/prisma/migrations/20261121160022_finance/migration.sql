-- AlterTable
ALTER TABLE "Attendance" ADD COLUMN     "subscriptionId" TEXT;

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "createdById" TEXT,
ADD COLUMN     "subscriptionId" TEXT,
ADD COLUMN     "type" TEXT NOT NULL DEFAULT 'payment';

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "teacherCategory" TEXT NOT NULL DEFAULT 'new';

-- CreateTable
CREATE TABLE "Tariff" (
    "id" TEXT NOT NULL,
    "courseId" TEXT,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "lessons" INTEGER NOT NULL,
    "price" DECIMAL(12,2) NOT NULL,
    "installments" INTEGER NOT NULL DEFAULT 1,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Tariff_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Subscription" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "groupId" TEXT,
    "tariffId" TEXT,
    "type" TEXT NOT NULL,
    "lessonsTotal" INTEGER NOT NULL,
    "basePrice" DECIMAL(12,2) NOT NULL,
    "discountPercent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "discountType" TEXT,
    "promoCode" TEXT,
    "price" DECIMAL(12,2) NOT NULL,
    "installments" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'active',
    "startDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),
    "closeReason" TEXT,
    "fromSubscriptionId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Subscription_studentId_status_idx" ON "Subscription"("studentId", "status");

-- CreateIndex
CREATE INDEX "Attendance_subscriptionId_idx" ON "Attendance"("subscriptionId");

-- AddForeignKey
ALTER TABLE "Attendance" ADD CONSTRAINT "Attendance_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Tariff" ADD CONSTRAINT "Tariff_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_tariffId_fkey" FOREIGN KEY ("tariffId") REFERENCES "Tariff"("id") ON DELETE SET NULL ON UPDATE CASCADE;
