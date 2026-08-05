/**
 * Off-app thumbnail harness. Mounted instead of <App/> when the URL carries
 * `?thumbs` (see main.tsx). It renders a fixed-size WebGL viewport and exposes
 * `window.__thumb` so a Playwright script can load each example and capture the
 * REAL shaded scene (smooth normals, depth buffer, AA) — far nicer than the
 * Node isometric SVG. See scripts/shoot-thumbs.ts.
 */
import { useEffect, useRef } from "react";
import { Viewport } from "./viewport";
import { kernel, type Graph } from "./kernel/client";

interface Edge { source: string; target: string; sourceHandle?: string | null; targetHandle?: string | null }
interface SceneNode { id: string; type?: string; data: { nodeType: string; params: Record<string, unknown> } }
interface SceneDoc { outputId: string; nodes: SceneNode[]; edges?: Edge[] }

const EXAMPLES = Object.entries(
  import.meta.glob("../examples/*.json", { eager: true, import: "default" }),
)
  .map(([path, doc]) => ({ name: path.split("/").pop()!.replace(/\.json$/, ""), doc: doc as SceneDoc }))
  .sort((a, b) => a.name.localeCompare(b.name));

/** SceneDoc (nodes + edges) → kernel Graph (inputs folded onto each node). */
function sceneToGraph(doc: SceneDoc): { graph: Graph; out: string } {
  const edges = doc.edges ?? [];
  const graph = doc.nodes
    .filter((n) => (n.type ?? "geo") !== "note")
    .map((n) => {
      const inputs: Record<string, string> = {};
      for (const e of edges) {
        if (e.target === n.id && e.targetHandle)
          inputs[e.targetHandle] = e.sourceHandle && e.sourceHandle !== "out" ? `${e.source}#${e.sourceHandle}` : e.source;
      }
      return { id: n.id, type: n.data.nodeType, params: n.data.params, inputs };
    });
  return { graph: graph as unknown as Graph, out: doc.outputId };
}

const raf = () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));

export default function ThumbHarness() {
  const mountRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!mountRef.current) return;
    const vp = new Viewport(mountRef.current);
    vp.setBackground(0x14171c); // match the gallery tile so thumbnails blend in
    vp.setGridVisible(false); // clean, grid-free tiles
    (window as unknown as { __thumb: unknown }).__thumb = {
      names: EXAMPLES.map((e) => e.name),
      async shoot(name: string): Promise<string> {
        const ex = EXAMPLES.find((e) => e.name === name);
        if (!ex) throw new Error(`no example "${name}"`);
        const { graph, out } = sceneToGraph(ex.doc);
        const res = await kernel.evalGraph(graph, out, [], {});
        if (!res.ok) throw new Error(res.error.message);
        vp.setGeometry(res.mesh, true); // reframe onto the model
        // 2D profiles read best flat-on rather than in the isometric frame
        if (res.outputKind === "sketch2d") vp.topView();
        await raf();
        return vp.snapshotScaled(256); // supersampled 720→256 for crisp, small PNGs
      },
    };
    (window as unknown as { __thumbReady: boolean }).__thumbReady = true;
  }, []);
  // a fixed square canvas → square PNGs straight out of toDataURL
  return <div ref={mountRef} style={{ position: "fixed", top: 0, left: 0, width: 360, height: 360 }} />;
}
