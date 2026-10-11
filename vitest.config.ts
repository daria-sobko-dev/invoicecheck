import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Environment variables only for tests:
    env: {
      // Empty key: if a test accidentally reaches a Gemini call, the code fails right away
      // instead of using up the quota. dotenv does not overwrite variables that are already set.
      GEMINI_API_KEY: "",
      // Separate queue: the worker listens to "invoices" and will not take test jobs.
      QUEUE_NAME: "invoices-test",
      // No traces in Langfuse.
      LANGFUSE_PUBLIC_KEY: "",
      LANGFUSE_SECRET_KEY: "",
    },
  },
});
