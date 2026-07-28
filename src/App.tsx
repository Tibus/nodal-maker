import { useEffect, useRef, useState, useCallback } from "react";
import type { Edge, Node } from "@xyflow/react";
import { Viewport } from "./viewport";
import NodeEditor, { type EditorApi } from "./NodeEditor";
import { kernel, type Graph } from "./kernel/client";
import { DEFAULT_PARAMS } from "./kernel/model";

// Seed graph shown on first load: star → offset → extrude → boss-on-cap.
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

function download(data: BlobPart, name: string, type: string) {
  const blob = new Blob([data], { type });
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
  const graphTimer = useRef<number | undefined>(undefined);
  const editorApi = useRef<EditorApi | null>(null);
  const [status, setStatus] = useState("initialising kernels…");
  const [graphError, setGraphError] = useState<{ nodeId?: string; message: string } | null>(null);
  const [graphValues, setGraphValues] = useState<Record<string, string>>({});
  const [pickMode, setPickMode] = useState<"face" | "edge" | "border" | null>(null);
  const [viewMode, setViewMode] = useState<"shaded" | "edges" | "wireframe">("shaded");
  const hoverRAF = useRef<number | undefined>(undefined);
  const lastHover = useRef<{ x: number; y: number } | null>(null);

  // live hover highlight while a pick mode is active — shows exactly what a
  // click would select. rAF-throttled so mousemove stays cheap.
  const onViewportMove = useCallback(
    (e: React.MouseEvent) => {
      if (!pickMode) return;
      lastHover.current = { x: e.clientX, y: e.clientY };
      if (hoverRAF.current != null) return;
      hoverRAF.current = requestAnimationFrame(() => {
        hoverRAF.current = undefined;
        const p = lastHover.current;
        if (p && pickMode) viewportRef.current?.hoverHighlight(pickMode, p.x, p.y);
      });
    },
    [pickMode],
  );

  // clear the highlight when leaving the viewport or exiting pick mode
  const clearHover = useCallback(() => viewportRef.current?.clearPick(), []);
  useEffect(() => {
    if (!pickMode) viewportRef.current?.clearPick();
  }, [pickMode]);

  // click in the viewport (pick mode) → a preconfigured Face/Edge Select node
  const onViewportClick = useCallback(
    (e: React.MouseEvent) => {
      if (!pickMode) return;
      if (pickMode === "face") {
        const pick = viewportRef.current?.pickFace(e.clientX, e.clientY);
        if (!pick) { setStatus("pick: no face under the cursor"); return; }
        const where = pick.axis === "curved" ? "cylindrical" : `at${pick.axis}`;
        editorApi.current?.addFaceSelect(where, pick.offset);
        setStatus(
          pick.axis === "curved"
            ? "picked a curved face → Face Select (cylindrical)"
            : `picked ${pick.tag} face at ${pick.axis}=${pick.offset} → Face Select (at${pick.axis})`,
        );
      } else if (pickMode === "border") {
        // border = the edges bounding a picked FACE (its outline loop), i.e. an
        // Edge Select at that face's plane → chamfer/fillet a face's rim.
        const pick = viewportRef.current?.pickBorder(e.clientX, e.clientY);
        if (!pick) { setStatus("border: pick a FLAT face (its rim lies in a plane)"); return; }
        editorApi.current?.addEdgeSelect(`at${pick.axis}`, pick.offset);
        setStatus(`picked border → Edge Select (at${pick.axis} @${pick.offset})`);
      } else {
        const pick = viewportRef.current?.pickEdge(e.clientX, e.clientY);
        if (!pick) { setStatus("pick: no edge near the cursor"); return; }
        editorApi.current?.addEdgeSelect(pick.where, pick.offset);
        setStatus(`picked edge → Edge Select (${pick.where}${pick.where === "atZ" ? ` @${pick.offset}` : ""})`);
      }
      setPickMode(null);
    },
    [pickMode],
  );

  useEffect(() => {
    if (mountRef.current && !viewportRef.current) {
      viewportRef.current = new Viewport(mountRef.current);
      viewportRef.current.reframeOnNext(); // recenter the camera on the first model
    }
  }, []);

  const onGraphChange = useCallback((graph: Graph, outputId: string, pinnedIds: string[]) => {
    window.clearTimeout(graphTimer.current);
    graphTimer.current = window.setTimeout(async () => {
      try {
        const res = await kernel.evalGraph(graph, outputId, pinnedIds);
        if (!res.ok) {
          setGraphError(res.error);
          setStatus("⚠ " + res.error.message);
          return;
        }
        setGraphError(null);
        setGraphValues(res.values ?? {});
        viewportRef.current?.setGeometry(res.mesh);
        viewportRef.current?.setExtraBodies(res.extras ?? []);
        setStatus(`${res.mesh.stats.faceCount} regions · ${res.mesh.stats.triangleCount} triangles`);

        // gizmo bound to the displayed transform-family node
        const out = graph.find((n) => n.id === outputId);
        const vp = viewportRef.current;
        if (out?.type === "transform") {
          const r = (v: number) => Math.round(v * 2) / 2;
          vp?.showTranslateGizmo(
            [Number(out.params?.tx ?? 0), Number(out.params?.ty ?? 0), Number(out.params?.tz ?? 0)],
            ([nx, ny, nz]) => {
              editorApi.current?.setParam(outputId, "tx", r(nx));
              editorApi.current?.setParam(outputId, "ty", r(ny));
              editorApi.current?.setParam(outputId, "tz", r(nz));
            },
          );
        } else if (out?.type === "rotate3d") {
          const axis = String(out.params?.axis ?? "Z") as "X" | "Y" | "Z";
          vp?.showRotateGizmo(axis, Number(out.params?.angle ?? 0), (deg) =>
            editorApi.current?.setParam(outputId, "angle", Math.round(deg)),
          );
        } else if (out?.type === "scale3d") {
          vp?.showScaleGizmo(Number(out.params?.factor ?? 1), (f) =>
            editorApi.current?.setParam(outputId, "factor", Math.round(f * 20) / 20),
          );
        } else {
          vp?.hideGizmo();
        }
      } catch (e) {
        setStatus("error: " + (e instanceof Error ? e.message : String(e)));
      }
    }, 250);
  }, []);

  return (
    <div className="app">
      <NodeEditor
        initialNodes={SEED_NODES}
        initialEdges={SEED_EDGES}
        initialOutputId="boss"
        onChange={onGraphChange}
        onReady={(api) => {
          editorApi.current = api;
        }}
        onFit={() => viewportRef.current?.fit()}
        onTopView={() => viewportRef.current?.topView()}
        onExportPNG={() => {
          const url = viewportRef.current?.snapshotPNG();
          if (url) {
            const a = document.createElement("a");
            a.href = url;
            a.download = "maker-render.png";
            a.click();
          }
        }}
        errorNodeId={graphError?.nodeId ?? null}
        errorMessage={graphError?.message ?? null}
        values={graphValues}
        onExportSTL={async (graph, outputId) => {
          try {
            const bytes = await kernel.exportGraphSTL(graph, outputId);
            download(bytes as unknown as BlobPart, "maker-graph.stl", "model/stl");
          } catch (e) {
            setStatus("export error: " + (e instanceof Error ? e.message : String(e)));
          }
        }}
        onExportSVG={async (graph, outputId) => {
          try {
            const svg = await kernel.exportGraphSVG(graph, outputId);
            download(svg, "maker-graph.svg", "image/svg+xml");
          } catch (e) {
            setStatus("export error: " + (e instanceof Error ? e.message : String(e)));
          }
        }}
        onExportDXF={async (graph, outputId) => {
          try {
            const dxf = await kernel.exportGraphDXF(graph, outputId);
            download(dxf, "maker-graph.dxf", "application/dxf");
          } catch (e) {
            setStatus("export error: " + (e instanceof Error ? e.message : String(e)));
          }
        }}
        onExportSTEP={async (graph, outputId) => {
          try {
            const bytes = await kernel.exportGraphSTEP(graph, outputId);
            download(bytes as unknown as BlobPart, "maker-graph.step", "application/step");
          } catch (e) {
            setStatus("export error: " + (e instanceof Error ? e.message : String(e)));
          }
        }}
      />
      <div
        className={`viewport${pickMode ? " viewport--pick" : ""}`}
        ref={mountRef}
        onClick={onViewportClick}
        onMouseMove={onViewportMove}
        onMouseLeave={clearHover}
      >
        <div className="vp-picks">
          <button
            className={`vp-pick${pickMode === "face" ? " vp-pick--on" : ""}`}
            onClick={(e) => { e.stopPropagation(); setPickMode((v) => (v === "face" ? null : "face")); }}
            title="Pick a face in the viewport → creates a Face Select node (auto-wires into the viewed fillet/shell)"
          >
            🎯 {pickMode === "face" ? "Click a face…" : "Pick face"}
          </button>
          <button
            className={`vp-pick${pickMode === "edge" ? " vp-pick--on" : ""}`}
            onClick={(e) => { e.stopPropagation(); setPickMode((v) => (v === "edge" ? null : "edge")); }}
            title="Pick an edge in the viewport → creates an Edge Select node (auto-wires into the viewed fillet/bevel)"
          >
            📐 {pickMode === "edge" ? "Click an edge…" : "Pick edge"}
          </button>
          <button
            className={`vp-pick${pickMode === "border" ? " vp-pick--on" : ""}`}
            onClick={(e) => { e.stopPropagation(); setPickMode((v) => (v === "border" ? null : "border")); }}
            title="Pick a flat face → selects its border (rim) edges as an Edge Select (auto-wires into a fillet/bevel)"
          >
            ▢ {pickMode === "border" ? "Click a face…" : "Pick border"}
          </button>
          <button
            className="vp-pick vp-pick--view"
            onClick={(e) => {
              e.stopPropagation();
              const next =
                viewMode === "shaded" ? "edges" : viewMode === "edges" ? "wireframe" : "shaded";
              setViewMode(next);
              viewportRef.current?.setViewMode(next);
            }}
            title="Cycle display: shaded → shaded + B-rep edges → wireframe (construction edges only)"
          >
            {viewMode === "shaded" ? "◧ Shaded" : viewMode === "edges" ? "◫ Edges" : "△ Wireframe"}
          </button>
        </div>
        <div className="statusbar">{status}</div>
      </div>
    </div>
  );
}
