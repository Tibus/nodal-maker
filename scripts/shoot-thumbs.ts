/**
 * High-quality example thumbnails by screenshotting the REAL WebGL scene.
 * Spawns a Vite dev server, opens the app's ?thumbs harness in headless
 * Chromium (SwiftShader), and captures each example's shaded render to a PNG.
 * Missing-only by default (fast, CI-friendly); pass --force to redo all.
 *
 * Run: npx tsx scripts/shoot-thumbs.ts [--force]
 */
import { spawn } from "child_process";
import { writeFileSync, mkdirSync, existsSync, readdirSync } from "fs";
import { chromium } from "playwright";

const PORT = 5199;
const outDir = "public/thumbs";
const force = process.argv.includes("--force");
mkdirSync(outDir, { recursive: true });

// Decide the work up-front from the filesystem, so the common "nothing missing"
// case (every deploy where thumbnails are committed) never boots vite/chromium.
const wanted = readdirSync("examples").filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")).sort();
const missing = wanted.filter((n) => force || !existsSync(`${outDir}/${n}.png`));
if (missing.length === 0) {
  process.stdout.write(`all ${wanted.length} thumbnails present — nothing to shoot\n`);
  process.exit(0);
}
process.stdout.write(`${missing.length} thumbnail(s) to shoot (of ${wanted.length})…\n`);

async function waitFor(url: string, tries = 60): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try { if ((await fetch(url)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`server did not come up at ${url}`);
}

const vite = spawn("npx", ["vite", "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"], {
  stdio: "ignore",
  env: process.env,
});
const cleanup = () => { try { vite.kill("SIGTERM"); } catch { /* ignore */ } };
process.on("exit", cleanup);
process.on("SIGINT", () => { cleanup(); process.exit(1); });

try {
  const base = `http://127.0.0.1:${PORT}`;
  await waitFor(base + "/");
  const browser = await chromium.launch();
  const page = await browser.newPage({ deviceScaleFactor: 2 }); // retina-crisp
  page.on("pageerror", (e) => process.stdout.write(`  ! page error: ${e.message}\n`));
  await page.goto(`${base}/?thumbs`, { waitUntil: "load" });
  await page.waitForFunction(() => (window as unknown as { __thumbReady?: boolean }).__thumbReady === true, { timeout: 30000 });

  let ok = 0, fail = 0, bytes = 0;
  for (const name of missing) {
    try {
      const dataUrl: string = await page.evaluate(
        (n) => (window as unknown as { __thumb: { shoot: (n: string) => Promise<string> } }).__thumb.shoot(n),
        name,
      );
      const png = Buffer.from(dataUrl.split(",")[1], "base64");
      writeFileSync(`${outDir}/${name}.png`, png);
      ok++; bytes += png.length;
      process.stdout.write(`  ✓ ${name} (${(png.length / 1024).toFixed(1)} KB)\n`);
    } catch (e) {
      fail++; process.stdout.write(`  ✗ ${name}: ${e instanceof Error ? e.message : e}\n`);
    }
  }
  await browser.close();
  process.stdout.write(`\nshot ${ok} thumbnail(s) (${(bytes / 1024).toFixed(0)} KB), ${fail} failed\n`);
} catch (e) {
  // thumbnails are non-critical to a deploy — warn but never fail the build
  process.stdout.write(`\n! thumbnail capture skipped (${e instanceof Error ? e.message : e})\n`);
} finally {
  cleanup();
}
