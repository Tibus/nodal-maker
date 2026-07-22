import { useEffect, useRef, useState, useCallback } from "react";
import type { Edge, Node } from "@xyflow/react";
import { Viewport } from "./viewport";
import NodeEditor from "./NodeEditor";
import { kernel, type Params, type MeshImportParams, type Graph } from "./kernel/client";
import type { BuildResult } from "./kernel/model";
import { DEFAULT_PARAMS } from "./kernel/model";

type Mode = "form" | "graph";

// Seed the node editor with the default CAD pipeline (star → offset → extrude → boss).
const SEED_NODES: Node<{ nodeType: string; params: Record<string, unknown> }>[] = [
  { id: "svg", type: "geo", position: { x: 0, y: 40 },
    data: { nodeType: "svgInput", params: { d: DEFAULT_PARAMS.svgPath } } },
  { id: "off", type: "geo", position: { x: 220, y: 40 },
    data: { nodeType: "offset2d", params: { distance: DEFAULT_PARAMS.offset } } },
  { id: "ext", type: "geo", position: { x: 440, y: 40 },
    data: { nodeType: "extrude", params: { height: DEFAULT_PARAMS.height } } },
  { id: "boss", type: "geo", position: { x: 660, y: 40 },
    data: { nodeType: "bossOnCap", params: { height: DEFAULT_PARAMS.bossHeight, shrink: DEFAULT_PARAMS.bossShrink } } },
];
const SEED_EDGES: Edge[] = [
  { id: "e1", source: "svg", sourceHandle: "out", target: "off", targetHandle: "in", style: { stroke: "#c678dd" } },
  { id: "e2", source: "off", sourceHandle: "out", target: "ext", targetHandle: "in", style: { stroke: "#c678dd" } },
  { id: "e3", source: "ext", sourceHandle: "out", target: "boss", targetHandle: "in", style: { stroke: "#ff8c42" } },
  { id: "e4", source: "off", sourceHandle: "out", target: "boss", targetHandle: "profile", style: { stroke: "#c678dd" } },
];

function downloadBytes(bytes: Uint8Array, name: string) {
  const blob = new Blob([bytes as unknown as BlobPart], { type: "model/stl" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export default function App() {
  const mountRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<Viewport | null>(null);
  const [params, setParams] = useState<Params>(DEFAULT_PARAMS);
  const [info, setInfo] = useState<Omit<BuildResult, "mesh"> | null>(null);
  const [tags, setTags] = useState<{ top: number; side: number; bottom: number } | null>(null);
  const [status, setStatus] = useState("initialising kernels…");
  const [busy, setBusy] = useState(false);
  // mesh-domain (Manifold) state: an imported STL and whether to cut it
  const [stlBuf, setStlBuf] = useState<ArrayBuffer | null>(null);
  const [stlName, setStlName] = useState<string>("");
  const [meshCut, setMeshCut] = useState(false);
  const [mode, setMode] = useState<Mode>("form");
  const graphTimer = useRef<number | undefined>(undefined);

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

  // debounced rebuild on param change — CAD path only (form mode, no STL)
  useEffect(() => {
    if (mode !== "form" || stlBuf) return;
    const t = setTimeout(() => void rebuild(params), 200);
    return () => clearTimeout(t);
  }, [params, rebuild, stlBuf, mode]);

  // graph mode: evaluate an arbitrary node graph in the worker (debounced)
  const onGraphChange = useCallback((graph: Graph, outputId: string) => {
    window.clearTimeout(graphTimer.current);
    graphTimer.current = window.setTimeout(async () => {
      setBusy(true);
      try {
        const res = await kernel.evalGraph(graph, outputId);
        viewportRef.current?.setGeometry(res.mesh);
        setTags(res.mesh.stats.tagCounts);
        setInfo(res.topCapFaceId !== null ? { topCapFaceId: res.topCapFaceId, topCapZ: res.topCapZ } : null);
        setStatus(
          `graph · ${res.mesh.stats.faceCount} regions · ${res.mesh.stats.triangleCount} triangles`,
        );
      } catch (e) {
        setStatus("error: " + (e instanceof Error ? e.message : String(e)));
      } finally {
        setBusy(false);
      }
    }, 250);
  }, []);

  // mesh-domain rebuild: an STL is loaded → import + repair (+ optional cut)
  const meshOpts = useCallback(
    (): MeshImportParams => ({
      cut: meshCut,
      svgPath: params.svgPath,
      cutOffset: params.offset,
      cutHeight: params.height,
    }),
    [meshCut, params.svgPath, params.offset, params.height],
  );

  useEffect(() => {
    if (mode !== "form" || !stlBuf) return;
    let cancelled = false;
    setBusy(true);
    const t = setTimeout(async () => {
      try {
        const res = await kernel.importMesh(stlBuf, meshOpts());
        if (cancelled) return;
        viewportRef.current?.setGeometry(res.mesh);
        setTags(res.mesh.stats.tagCounts);
        setInfo(null);
        setStatus(
          `imported "${stlName}" · ${res.mesh.stats.faceCount} regions · ` +
            `${res.mesh.stats.triangleCount} triangles${meshCut ? " · cut ✓" : ""}`,
        );
      } catch (e) {
        if (!cancelled) setStatus("error: " + (e instanceof Error ? e.message : String(e)));
      } finally {
        if (!cancelled) setBusy(false);
      }
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [stlBuf, stlName, meshCut, meshOpts, mode]);

  const set = <K extends keyof Params>(key: K, value: Params[K]) =>
    setParams((p) => ({ ...p, [key]: value }));

  const onPickStl = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setStlName(f.name);
    setStlBuf(await f.arrayBuffer());
  };

  const clearStl = () => {
    setStlBuf(null);
    setStlName("");
    setMeshCut(false);
  };

  const exportStl = async () => {
    const bytes = stlBuf
      ? await kernel.exportMeshSTL(stlBuf, meshOpts())
      : await kernel.exportSTL(params);
    downloadBytes(bytes as Uint8Array, stlBuf ? "maker-mesh.stl" : "maker-model.stl");
  };

  return (
    <div className="app" data-mode={mode}>
      <div className="modebar">
        <button className={mode === "form" ? "seg seg--on" : "seg"} onClick={() => setMode("form")}>
          Form
        </button>
        <button className={mode === "graph" ? "seg seg--on" : "seg"} onClick={() => setMode("graph")}>
          Graph
        </button>
      </div>

      {mode === "graph" ? (
        <NodeEditor
          initialNodes={SEED_NODES}
          initialEdges={SEED_EDGES}
          initialOutputId="boss"
          onChange={onGraphChange}
        />
      ) : (
      <div className="panel">
        <h1>maker · spike</h1>
        <p className="sub">
          {stlBuf
            ? "STL → repair → boolean cut · Manifold (mesh bridge)"
            : "SVG → offset → extrude → boss-on-cap · replicad/OCCT"}
        </p>

        <div className="mesh-import">
          <label className="filebtn">
            📥 Import STL
            <input type="file" accept=".stl,model/stl" onChange={onPickStl} hidden />
          </label>
          {stlBuf && (
            <>
              <span className="fname" title={stlName}>{stlName}</span>
              <button className="link" onClick={clearStl}>← back to CAD</button>
            </>
          )}
        </div>

        {stlBuf && (
          <label className="row">
            <input
              type="checkbox"
              checked={meshCut}
              onChange={(e) => setMeshCut(e.target.checked)}
            />
            Cut with SVG shape (mesh difference)
          </label>
        )}

        <label>
          SVG path{" "}
          <span className="hint">{stlBuf ? "(cutter profile)" : "(d attribute)"}</span>
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

        {!stlBuf && (
          <label className="row">
            <input type="checkbox" checked={params.boss}
              onChange={(e) => set("boss", e.target.checked)} />
            Boss on top cap (persistence spike)
          </label>
        )}

        {!stlBuf && params.boss && (
          <>
            <Slider label="Boss height" min={1} max={40} step={1} value={params.bossHeight}
              onChange={(v) => set("bossHeight", v)} />
            <Slider label="Boss inset" min={1} max={30} step={0.5} value={params.bossShrink}
              onChange={(v) => set("bossShrink", v)} />
          </>
        )}

        <button onClick={exportStl} disabled={busy}>⬇ Export STL</button>

        <div className="status">{busy ? "building…" : status}</div>

        {tags && (
          <div className="readout">
            <div className="legend">
              <Swatch c="#ff8c42" n={`top ${tags.top}`} />
              <Swatch c="#4a90d9" n={`side ${tags.side}`} />
              <Swatch c="#8a8f98" n={`bottom ${tags.bottom}`} />
            </div>
            {info && (
            <div className="spike">
              <strong>Top-cap selector →</strong> resolved faceId{" "}
              <code>{String(info.topCapFaceId)}</code> @ z={info.topCapZ.toFixed(2)}
              <p className="note">
                Change the height: the raw faceId jumps around, but the cap is always
                re-found by <em>query</em>, not by id. That's the topological-naming fix.
              </p>
            </div>
            )}
          </div>
        )}
      </div>
      )}

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
