-- CreateTable
CREATE TABLE "IssuedDocument" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "year" INTEGER NOT NULL,
    "studentId" TEXT NOT NULL,
    "subscriptionId" TEXT,
    "groupId" TEXT,
    "amount" DECIMAL(12,2),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IssuedDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExternalExam" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "score" DECIMAL(6,2),
    "status" TEXT NOT NULL DEFAULT 'registered',
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExternalExam_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "IssuedDocument_number_key" ON "IssuedDocument"("number");

-- CreateIndex
CREATE INDEX "IssuedDocument_studentId_idx" ON "IssuedDocument"("studentId");

-- CreateIndex
CREATE UNIQUE INDEX "IssuedDocument_type_year_seq_key" ON "IssuedDocument"("type", "year", "seq");

-- CreateIndex
CREATE INDEX "ExternalExam_studentId_idx" ON "ExternalExam"("studentId");

-- CreateIndex
CREATE INDEX "ExternalExam_date_idx" ON "ExternalExam"("date");

-- AddForeignKey
ALTER TABLE "IssuedDocument" ADD CONSTRAINT "IssuedDocument_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalExam" ADD CONSTRAINT "ExternalExam_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE CASCADE ON UPDATE CASCADE;

