import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

// `?thumbs` mounts the off-app thumbnail harness (used by scripts/shoot-thumbs.ts)
// instead of the full editor, so we can capture the real WebGL scene per example.
const thumbMode = new URLSearchParams(location.search).has("thumbs");

async function boot() {
  const root = createRoot(document.getElementById("root")!);
  if (thumbMode) {
    const { default: ThumbHarness } = await import("./ThumbHarness");
    root.render(<ThumbHarness />);
  } else {
    root.render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
  }
}
void boot();
