import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

// Test config for BOTH the existing server/data tests (node env — the default, unchanged) AND the new UI render
// tests (`*.ui.test.tsx`, which opt into jsdom via a `// @vitest-environment jsdom` docblock at the top of each
// file — so node stays the default and only UI files use jsdom). Adds the `@` → ./src alias so tests resolve the
// same import paths the app uses. No hosted/network access; nothing here reads a DB or secret.
export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@": resolve(__dirname, "./src") } },
  test: {
    environment: "node",
  },
});
