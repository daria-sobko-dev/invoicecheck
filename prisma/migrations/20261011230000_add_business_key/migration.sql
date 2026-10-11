-- AlterTable
ALTER TABLE "Document" ADD COLUMN     "invoiceNumber" TEXT,
ADD COLUMN     "vendor" TEXT;

-- Fill the business key for documents saved before this migration.
UPDATE "Document"
SET "invoiceNumber" = "extracted"->>'invoiceNumber',
    "vendor" = "extracted"->>'vendor'
WHERE "extracted" IS NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "Document_invoiceNumber_vendor_key" ON "Document"("invoiceNumber", "vendor");
