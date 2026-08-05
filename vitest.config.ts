import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 20000, // OCCT/Manifold WASM ops can be slow on the first run
    hookTimeout: 60000, // kernel boot in beforeAll
  },
});
