import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // `.tsx` was absent, which is why the two renderer files this project shipped in
    // Phase 27 had no unit tests: there was no way to write one. `environment` stays
    // `node` by default because every main-process suite depends on `fs`, `os` and a
    // mocked `electron`; renderer suites opt in with a `@vitest-environment jsdom`
    // pragma at the top of the file instead of splitting the project in two.
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    environment: "node",
  },
});