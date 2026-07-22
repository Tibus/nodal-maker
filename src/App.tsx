import { useEffect, useRef, useState, useCallback } from "react";
import { Viewport } from "./viewport";
import { kernel, type Params } from "./kernel/client";
import type { BuildResult } from "./kernel/model";
import { DEFAULT_PARAMS } from "./kernel/model";

export default function App() {
  const mountRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<Viewport | null>(null);
  const [params, setParams] = useState<Params>(DEFAULT_PARAMS);
  const [info, setInfo] = useState<Omit<BuildResult, "mesh"> | null>(null);
  const [tags, setTags] = useState<{ top: number; side: number; bottom: number } | null>(null);
  const [status, setStatus] = useState("initialising OCCT…");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (mountRef.current && !viewportRef.current) {
      viewportRef.current = new Viewport(mountRef.current);
    }
  }, []);

  const rebuild = useCallback(async (p: Params) => {
    setBusy(true);
    try {
      const res = await kernel.build(p);
      viewportRef.current?.setGeometry(res.mesh);
      setInfo({ topCapFaceId: res.topCapFaceId, topCapZ: res.topCapZ });
      setTags(res.mesh.stats.tagCounts);
      setStatus(
        `${res.mesh.stats.faceCount} B-rep faces · ${res.mesh.stats.triangleCount} triangles`,
      );
    } catch (e) {
      setStatus("error: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
    }
  }, []);

  // debounced rebuild on param change
  useEffect(() => {
    const t = setTimeout(() => void rebuild(params), 200);
    return () => clearTimeout(t);
  }, [params, rebuild]);

  const set = <K extends keyof Params>(key: K, value: Params[K]) =>
    setParams((p) => ({ ...p, [key]: value }));

  const exportStl = async () => {
    const bytes = await kernel.exportSTL(params);
    const blob = new Blob([bytes as unknown as BlobPart], { type: "model/stl" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "maker-model.stl";
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="app">
      <div className="panel">
        <h1>maker · spike</h1>
        <p className="sub">SVG → offset → extrude → boss-on-cap · replicad/OCCT</p>

        <label>
          SVG path <span className="hint">(d attribute)</span>
          <textarea
            value={params.svgPath}
            onChange={(e) => set("svgPath", e.target.value)}
            rows={3}
            spellCheck={false}
          />
        </label>

        <Slider label="2D offset" min={-10} max={20} step={0.5} value={params.offset}
          onChange={(v) => set("offset", v)} />
        <Slider label="Extrude height" min={1} max={60} step={1} value={params.height}
          onChange={(v) => set("height", v)} />

        <label className="row">
          <input type="checkbox" checked={params.boss}
            onChange={(e) => set("boss", e.target.checked)} />
          Boss on top cap (persistence spike)
        </label>

        {params.boss && (
          <>
            <Slider label="Boss height" min={1} max={40} step={1} value={params.bossHeight}
              onChange={(v) => set("bossHeight", v)} />
            <Slider label="Boss inset" min={1} max={30} step={0.5} value={params.bossShrink}
              onChange={(v) => set("bossShrink", v)} />
          </>
        )}

        <button onClick={exportStl} disabled={busy}>⬇ Export STL</button>

        <div className="status">{busy ? "building…" : status}</div>

        {info && tags && (
          <div className="readout">
            <div className="legend">
              <Swatch c="#ff8c42" n={`top ${tags.top}`} />
              <Swatch c="#4a90d9" n={`side ${tags.side}`} />
              <Swatch c="#8a8f98" n={`bottom ${tags.bottom}`} />
            </div>
            <div className="spike">
              <strong>Top-cap selector →</strong> resolved faceId{" "}
              <code>{String(info.topCapFaceId)}</code> @ z={info.topCapZ.toFixed(2)}
              <p className="note">
                Change the height: the raw faceId jumps around, but the cap is always
                re-found by <em>query</em>, not by id. That's the topological-naming fix.
              </p>
            </div>
          </div>
        )}
      </div>

      <div className="viewport" ref={mountRef} />
    </div>
  );
}

function Slider(props: {
  label: string; min: number; max: number; step: number; value: number;
  onChange: (v: number) => void;
}) {
  return (
    <label>
      <span className="lbl">{props.label}<span className="val">{props.value}</span></span>
      <input type="range" min={props.min} max={props.max} step={props.step}
        value={props.value} onChange={(e) => props.onChange(Number(e.target.value))} />
    </label>
  );
}

function Swatch({ c, n }: { c: string; n: string }) {
  return (
    <span className="swatch">
      <i style={{ background: c }} /> {n}
    </span>
  );
}
