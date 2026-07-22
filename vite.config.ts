import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // OCCT and Manifold are prebuilt wasm+glue modules; let Vite serve them as-is.
  optimizeDeps: { exclude: ["replicad-opencascadejs", "manifold-3d"] },
  worker: { format: "es" },
  server: { host: true },
});
