/**
 * Visual node editor (React Flow) sitting on top of the graph engine in
 * `nodes.ts`. It never runs geometry itself: it edits a graph of typed nodes
 * and emits a plain, serialisable `Graph` (+ which node to display) upward, so
 * the parent can evaluate it off-thread in the worker.
 *
 * Highlights:
 *  - sockets are typed (sketch2d / solid / mesh) and colour-coded;
 *  - a connection is rejected when the types don't match, EXCEPT solid→mesh,
 *    where a `tessellate` node is auto-inserted (the B-rep→mesh bridge);
 *  - editing a param or rewiring emits a fresh graph for live evaluation.
 */
import { useCallback, useEffect, useMemo, useRef, useState, createContext, useContext } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  addEdge,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  type Connection,
  type NodeProps,
  type ReactFlowInstance,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  NODE_SPECS,
  NODE_CATEGORIES,
  NODE_DESCRIPTIONS,
  NODE_THUMBS,
  SOCKET_COLORS,
  SOCKET_LABELS,
  paramPortType,
  expandDescriptors,
  expandOutputId,
  type Graph,
  type ParamSpec,
  type SocketType,
  type ComponentDef,
  type InstanceDescriptor,
} from "./kernel/client";
import { starterRect, docFromReference } from "./sketch/presets";
import { evalExpr } from "./kernel/expr";
import { dimensions, isDim, type SketchDoc } from "./sketch/model";
import SketchEditor from "./SketchEditor";

type GeoData = {
  nodeType: string;
  params: Record<string, unknown>;
  /** set when this node is a component instance (points at a ComponentDef id) */
  component?: string;
  /** user-given name shown on the node + in the Simple form (double-click title) */
  alias?: string;
};
type GeoNode = Node<GeoData>;

/** Nodes a selection can be carried through — must mirror FORWARD_TYPES in the
 * kernel. Each re-exposes the selection ports of whatever feeds its `in` port. */
const FORWARD_SEL = new Set(["transform", "scale3d", "mirror3d", "rotate3d"]);

/** Compact glyph per node type for the history timeline (Fusion-style). */
const NODE_ICON: Record<string, string> = {
  numberValue: "#", textValue: "T", math: "∑", mathUnary: "ƒ", clamp: "⊓", remap: "↔", random: "?",
  rect: "▭", circle: "◯", ellipse: "⬭", polygon: "⬠", star: "★", slot: "▬", gear: "⚙",
  fingerBox: "⊟", svgInput: "✎", textToSvg: "T",
  offset2d: "⊙", kerf: "╎", fillet2d: "◜", bevel2d: "◹", boolean2d: "⊕", mirror2d: "⇋",
  transform2d: "✥", arrayLinear2d: "⋯", arrayRadial2d: "❋", group: "⊞", scoreCut: "✂",
  livingHinge: "⋮", nest: "▩", importDXF: "⇩", dogbone: "◵", tabs: "⊣", cncJob: "⌖",
  box: "◼", cylinder: "⬢", sphere: "●", cone: "▲", torus: "◎", thread: "⛊", internalThread: "⊙", importSTEP: "⇩",
  extrude: "⇧", pocket: "▣", hole: "⊗", revolve: "↻", loft: "⏛", loftSections: "≣", sweep: "∿", bossOnCap: "⊤", textOnFace: "A",
  transform: "✥", rotate3d: "⟳", scale3d: "⤢", mirror3d: "⇋", fillet: "◜", bevel: "◹",
  shell: "◫", hollow: "◌", infill: "▦", gyroid: "❈", split: "⊘", autoOrient: "⤾", supports: "⇟",
  boolean3d: "⊖", collision: "✸", color: "◐", arrange3d: "▤", assemble: "⧉", arrayLinear3d: "⋯", arrayRadial3d: "❋", arrayPath: "⌇",
  edgeSelect: "╱", faceSelect: "▱",
  tessellate: "△", meshToSolid: "◆", importSTL: "⇩", repair: "✚", boolean: "⊖", transformMesh: "✥",
  convexHull: "⬡", minkowski: "⊚", decimate: "▽", subdivide: "◈",
};
const nodeIcon = (type: string, isComponent: boolean) => (isComponent ? "⧉" : (NODE_ICON[type] ?? "◆"));

/** A "construction" node produces geometry (solid / sketch2d / mesh); helper
 * nodes (selection / number / text) only parametrise them and are hidden from
 * the timeline by default. */
function isConstructionNode(n: GeoNode, components: Record<string, ComponentDef>): boolean {
  const out = n.data.component
    ? components[n.data.component]?.outputType
    : NODE_SPECS[n.data.nodeType]?.output;
  return out === "solid" || out === "sketch2d" || out === "mesh";
}

type SelOut = { name: string; target: "face" | "edge" };

interface EditorCtx {
  outputId: string;
  setOutput: (id: string) => void;
  setParam: (id: string, name: string, value: unknown) => void;
  isLinked: (nodeId: string, port: string) => boolean;
  /** is a source handle (e.g. a selection output) currently wired to something? */
  isSourceLinked: (nodeId: string, handle: string) => boolean;
  errorNodeId: string | null;
  errorMessage: string | null;
  valueOf: (nodeId: string) => string | undefined;
  componentDef: (defId: string) => ComponentDef | undefined;
  /** effective selection outputs of a node (own, or forwarded from its input) */
  selOutputs: (nodeId: string) => SelOut[];
  /** hover a port handle → show/hide the socket-type tooltip */
  setPortTip: (tip: { type: SocketType; x: number; y: number } | null) => void;
  /** is this node's body shown (default true; false once the user hides it)? */
  isVisible: (nodeId: string) => boolean;
  toggleVisible: (nodeId: string) => void;
  /** open the 2D sketch editor overlay for a Sketch node */
  editSketch: (nodeId: string) => void;
  /** is this node param surfaced to the Simple form? toggle it */
  isExposed: (nodeId: string, param: string) => boolean;
  toggleExpose: (nodeId: string, param: string) => void;
  /** rename a node (alias shown on the node + in the Simple form) */
  setAlias: (nodeId: string, alias: string) => void;
  /** hover a selection-output port → highlight its geometry on the model */
  hoverPort: (nodeId: string, port: string) => void;
  clearHoverPort: () => void;
}
const Ctx = createContext<EditorCtx | null>(null);

/** The socket type accepted by a node's input handle (structural or param). */
function handleType(nodeType: string, handle: string): SocketType | undefined {
  const spec = NODE_SPECS[nodeType];
  if (!spec) return undefined;
  const structural = spec.inputs.find((p) => p.name === handle);
  if (structural) return structural.type;
  const param = spec.params.find((p) => p.name === handle);
  return param ? (paramPortType(param) ?? undefined) : undefined;
}

/* ------------------------------------------------------------------ */
/* Custom node                                                         */
/* ------------------------------------------------------------------ */

function GeoNodeView({ id, data }: NodeProps<GeoNode>) {
  const ctx = useContext(Ctx)!;
  const [selOpen, setSelOpen] = useState(false); // selection-outputs accordion
  const [renaming, setRenaming] = useState(false); // inline alias editor
  // hover handlers for a port handle → socket-type tooltip
  const tipH = (t: SocketType) => ({
    onMouseEnter: (e: React.MouseEvent) => ctx.setPortTip({ type: t, x: e.clientX, y: e.clientY }),
    onMouseLeave: () => ctx.setPortTip(null),
  });
  // a component instance derives its ports/params from its ComponentDef
  const def = data.component ? ctx.componentDef(data.component) : undefined;
  const spec = def
    ? {
        type: "__component",
        label: def.name,
        inputs: def.inputs.map((i) => ({ name: i.name, type: i.type })),
        output: def.outputType,
        params: def.params.map((p) => ({ ...p.spec, name: p.name, label: p.label })),
        selectionOutputs: [] as { name: string; target: "face" | "edge" }[],
      }
    : NODE_SPECS[data.nodeType];
  const isOutput = ctx.outputId === id;
  const isError = ctx.errorNodeId === id;
  const value = ctx.valueOf(id);

  if (!spec) return <div className="gnode gnode--error">unknown node</div>;

  return (
    <div
      className={`gnode${isOutput ? " gnode--out" : ""}${isError ? " gnode--error" : ""}`}
      onClick={() => ctx.setOutput(id)}
    >
      <div className="gnode__title">
        {renaming ? (
          <input
            className="gnode__rename"
            autoFocus
            defaultValue={data.alias ?? ""}
            placeholder={spec.label}
            onClick={(e) => e.stopPropagation()}
            onBlur={(e) => { ctx.setAlias(id, e.target.value.trim()); setRenaming(false); }}
            onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setRenaming(false); }}
          />
        ) : (
          <span
            className={data.alias ? "gnode__alias" : undefined}
            title="Double-clic pour renommer (affiché dans le mode Simple)"
            onDoubleClick={(e) => { e.stopPropagation(); setRenaming(true); }}
          >
            {data.alias || spec.label}
          </span>
        )}
        {isOutput && <span className="gnode__badge">● view</span>}
        <button
          className={`gnode__eye${ctx.isVisible(id) ? " gnode__eye--on" : ""}`}
          title={
            ctx.isVisible(id)
              ? "Visible — shown (translucent) alongside the viewed node (click to hide)"
              : "Hidden — click to show this body alongside the viewed node"
          }
          onClick={(e) => {
            e.stopPropagation();
            ctx.toggleVisible(id);
          }}
        >
          {ctx.isVisible(id) ? "👁" : "🚫"}
        </button>
      </div>
      {value !== undefined && <div className="gnode__value">= {value}</div>}
      {isError && <div className="gnode__err">⚠ {ctx.errorMessage}</div>}

      <div className="gnode__body" onClick={(e) => e.stopPropagation()}>
        {/* structural inputs — required, filled ports */}
        {spec.inputs.map((p) => {
          // selection ports accept SEVERAL wires (their union) — flag them with a
          // stacked-dot handle so it reads as "drop multiple here"
          const multi = p.type === "edgeSel" || p.type === "faceSel";
          return (
            <div className="gnode__row" key={`in-${p.name}`}>
              <Handle
                id={p.name}
                type="target"
                position={Position.Left}
                className={`rf-port rf-port--req sock-${p.type}${multi ? " rf-port--multi" : ""}`}
                style={{ background: SOCKET_COLORS[p.type] }}
                title={multi ? `${p.name}: ${p.type} — accepts several selections` : `${p.name}: ${p.type} (required)`}
                {...tipH(p.type)}
              />
              <span className="gnode__portlabel" style={{ color: SOCKET_COLORS[p.type] }}>
                {p.name}
              </span>
            </div>
          );
        })}

        {/* params — those that are portable get an OPTIONAL, hollow port */}
        {spec.params.map((ps) => {
          // the sketch doc renders as an "Edit" button plus one field per
          // driving dimension (those mirror into node params and re-solve)
          if (ps.kind === "sketch") {
            const doc = data.params[ps.name] as SketchDoc | null;
            const dims = doc ? dimensions(doc) : [];
            return (
              <div className="gnode__sketch" key={`p-${ps.name}`}>
                <button
                  className="gnode__editsketch"
                  onClick={(e) => { e.stopPropagation(); ctx.editSketch(id); }}
                  title="Open the 2D constraint sketch editor"
                >
                  ✎ Edit sketch
                </button>
                {dims.map((dm) => {
                  const dlinked = ctx.isLinked(id, dm.name);
                  return (
                    <div className="gnode__row gnode__row--param" key={`dim-${dm.name}`}>
                      <Handle
                        id={dm.name}
                        type="target"
                        position={Position.Left}
                        className="rf-port rf-port--opt sock-number"
                        style={{ borderColor: SOCKET_COLORS.number }}
                        title={`${dm.name}: number (optional — drives this dimension)`}
                        {...tipH("number")}
                      />
                      {dlinked ? (
                        <div className="pf pf--linked">
                          <span>{dm.name} ({dm.kind === "angle" ? "°" : "mm"})</span>
                          <em style={{ color: SOCKET_COLORS.number }}>◀ linked</em>
                        </div>
                      ) : (
                        <ParamField
                          spec={{ name: dm.name, kind: "number", label: `${dm.name} (${dm.kind === "angle" ? "°" : "mm"})`, step: 0.5 }}
                          value={data.params[dm.name] ?? dm.value}
                          onChange={(v) => ctx.setParam(id, dm.name, v)}
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            );
          }
          const pt = paramPortType(ps);
          const linked = pt !== null && ctx.isLinked(id, ps.name);
          return (
            <div className={`gnode__row${pt ? " gnode__row--param" : ""}`} key={`p-${ps.name}`}>
              {pt && (
                <Handle
                  id={ps.name}
                  type="target"
                  position={Position.Left}
                  className={`rf-port rf-port--opt sock-${pt}`}
                  style={{ borderColor: SOCKET_COLORS[pt] }}
                  title={`${ps.name}: ${pt} (optional — has a default)`}
                  {...tipH(pt)}
                />
              )}
              {linked ? (
                <div className="pf pf--linked">
                  <span>{ps.label ?? ps.name}</span>
                  <em style={{ color: SOCKET_COLORS[pt!] }}>◀ linked</em>
                </div>
              ) : (
                <div className="pf__wrap">
                  <ParamField
                    spec={ps}
                    value={data.params[ps.name]}
                    onChange={(v) => ctx.setParam(id, ps.name, v)}
                  />
                  <button
                    className={`pf__expose${ctx.isExposed(id, ps.name) ? " pf__expose--on" : ""}`}
                    title={ctx.isExposed(id, ps.name) ? "Exposé au mode Simple — cliquer pour retirer" : "Exposer ce paramètre au mode Simple"}
                    onClick={(e) => { e.stopPropagation(); ctx.toggleExpose(id, ps.name); }}
                  >
                    {ctx.isExposed(id, ps.name) ? "★" : "☆"}
                  </button>
                </div>
              )}
            </div>
          );
        })}

        {/* exposed selection outputs (cap / sides / edges…), tucked into a
            collapsible accordion so they're out of the way until needed.
            Connected ports stay rendered even when collapsed (keeps the wire). */}
        {(() => {
          const outs = ctx.selOutputs(id);
          if (outs.length === 0) return null;
          const shown = selOpen ? outs : outs.filter((so) => ctx.isSourceLinked(id, so.name));
          return (
            <div className="gnode__selgroup">
              <button
                className="gnode__selhd"
                onClick={(e) => { e.stopPropagation(); setSelOpen((v) => !v); }}
                title="Show / hide this node's face & edge selection outputs"
              >
                {selOpen ? "▾" : "▸"} selections ({outs.length})
              </button>
              {shown.map((so) => {
                const t: SocketType = so.target === "edge" ? "edgeSel" : "faceSel";
                return (
                <div
                  className="gnode__row gnode__row--out"
                  key={`so-${so.name}`}
                  onMouseEnter={() => ctx.hoverPort(id, so.name)}
                  onMouseLeave={() => ctx.clearHoverPort()}
                >
                  <span className="gnode__portlabel gnode__portlabel--r" style={{ color: SOCKET_COLORS[t] }}>
                    {so.name} ▶
                  </span>
                  <Handle
                    id={so.name}
                    type="source"
                    position={Position.Right}
                    className={`rf-port rf-port--req sock-${t}`}
                    style={{ background: SOCKET_COLORS[t] }}
                    title={`${so.name}: ${so.target} selection`}
                    {...tipH(t)}
                  />
                </div>
                );
              })}
            </div>
          );
        })()}
      </div>

      <Handle
        id="out"
        type="source"
        position={Position.Right}
        className={`rf-port rf-port--req sock-${spec.output}`}
        style={{ background: SOCKET_COLORS[spec.output], top: 22 }}
        title={`out: ${spec.output}`}
        {...tipH(spec.output)}
      />
    </div>
  );
}

function ParamField({
  spec,
  value,
  onChange,
}: {
  spec: ParamSpec;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const label = spec.label ?? spec.name;
  if (spec.kind === "number") {
    // a number field also accepts an expression ("width/2 + 4"); a plain number
    // is stored as a number, anything else as a string the kernel evaluates
    const isExpr = typeof value === "string" && value.trim() !== "" && Number.isNaN(Number(value));
    return (
      <label className="pf">
        <span>{label}</span>
        <input
          type="text"
          inputMode="decimal"
          className={isExpr ? "pf__expr" : undefined}
          title={isExpr ? "expression" : "number or expression (e.g. width/2)"}
          value={value == null ? "" : String(value)}
          onChange={(e) => {
            const raw = e.target.value;
            const n = Number(raw);
            onChange(raw.trim() !== "" && !Number.isNaN(n) ? n : raw);
          }}
        />
      </label>
    );
  }
  if (spec.kind === "select") {
    return (
      <label className="pf">
        <span>{label}</span>
        <select value={String(value ?? "")} onChange={(e) => onChange(e.target.value)}>
          {spec.options?.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      </label>
    );
  }
  if (spec.kind === "font") {
    return <FontField label={label} value={value} onChange={onChange} />;
  }
  if (spec.kind === "stl" || spec.kind === "step" || spec.kind === "dxf") {
    const isDxf = spec.kind === "dxf";
    const loaded = isDxf ? typeof value === "string" && value.length > 0 : value instanceof ArrayBuffer;
    const accept = spec.kind === "stl" ? ".stl,model/stl" : isDxf ? ".dxf,image/vnd.dxf" : ".step,.stp,application/step,model/step";
    const hint = spec.kind === "stl" ? "choose .stl" : isDxf ? "choose .dxf" : "choose .step";
    return (
      <label className="pf pf--file">
        <span>{label}</span>
        <span className="pf__filebtn">
          {loaded ? "✓ loaded" : hint}
          <input
            type="file"
            accept={accept}
            hidden
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (f) onChange(isDxf ? await f.text() : await f.arrayBuffer());
            }}
          />
        </span>
      </label>
    );
  }
  return (
    <label className="pf pf--text">
      <span>{label}</span>
      <textarea
        rows={2}
        value={String(value ?? "")}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

/** A locally-installed font, as returned by the Local Font Access API. */
interface LocalFontData {
  postscriptName: string;
  fullName: string;
  family: string;
  style: string;
  blob(): Promise<Blob>;
}
type QueryLocalFonts = () => Promise<LocalFontData[]>;

/**
 * Font picker for the Text → SVG node. In Chromium the Local Font Access API
 * (`queryLocalFonts`, permission-gated) lets us read the user's INSTALLED fonts
 * directly — no upload needed. Everywhere else we fall back to a file upload.
 */
function FontField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const loaded = value instanceof ArrayBuffer;
  const query = (window as unknown as { queryLocalFonts?: QueryLocalFonts }).queryLocalFonts;
  const [fonts, setFonts] = useState<LocalFontData[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const loadSystemFonts = async () => {
    if (!query) return;
    setBusy(true);
    setErr(null);
    try {
      // de-dupe by family (keep the first/regular style we see)
      const list = await query();
      const seen = new Set<string>();
      const uniq = list.filter((f) => (seen.has(f.family) ? false : (seen.add(f.family), true)));
      uniq.sort((a, b) => a.family.localeCompare(b.family));
      setFonts(uniq);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "access denied");
    } finally {
      setBusy(false);
    }
  };

  const pick = async (postscriptName: string) => {
    const f = fonts?.find((x) => x.postscriptName === postscriptName);
    if (!f) return;
    onChange(await (await f.blob()).arrayBuffer());
  };

  return (
    <div className="pf pf--file">
      <span>{label}</span>
      {query && !fonts && (
        <button type="button" className="pf__filebtn" onClick={loadSystemFonts} disabled={busy}>
          {busy ? "…" : "use a system font"}
        </button>
      )}
      {fonts && (
        <select className="pf__select" defaultValue="" onChange={(e) => pick(e.target.value)}>
          <option value="" disabled>
            {loaded ? "✓ pick another…" : `choose a font (${fonts.length})…`}
          </option>
          {fonts.map((f) => (
            <option key={f.postscriptName} value={f.postscriptName}>
              {f.family}
            </option>
          ))}
        </select>
      )}
      <label className="pf__filebtn">
        {loaded ? "✓ loaded — or upload" : "or upload .ttf/.otf"}
        <input
          type="file"
          accept=".ttf,.otf,font/ttf,font/otf"
          hidden
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (f) onChange(await f.arrayBuffer());
          }}
        />
      </label>
      {err && <span className="pf__err">font access: {err}</span>}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Editor                                                              */
/* ------------------------------------------------------------------ */

/** A comment / frame node: free-floating editable text for organising the graph.
 * It never reaches the graph engine (see `isNote`) — purely visual. */
function NoteView({ id, data }: NodeProps<GeoNode>) {
  const ctx = useContext(Ctx)!;
  const text = String(data.params.text ?? "");
  return (
    <div className="note" onClick={(e) => e.stopPropagation()}>
      <textarea
        className="note__text nodrag"
        value={text}
        placeholder="Comment…"
        onChange={(e) => ctx.setParam(id, "text", e.target.value)}
      />
    </div>
  );
}

const nodeTypes = { geo: GeoNodeView, note: NoteView };

export interface EditorApi {
  /** imperatively set a node param (used by the 3D gizmo to write tx/ty/tz) */
  setParam: (nodeId: string, name: string, value: unknown) => void;
  /** add a Face/Edge Select node preconfigured from a viewport pick */
  addFaceSelect: (where: string, offset: number, box?: number[], ref?: unknown) => void;
  addEdgeSelect: (where: string, offset: number, near?: [number, number, number], ref?: unknown) => void;
  /** create a new Sketch node on a base plane at an offset (with optional face
   * outline as reference geometry), and open the editor */
  addSketchOnPlane: (base: "XY" | "XZ" | "YZ", offset: number, reference?: [number, number][][]) => void;
  /** create a new Sketch node on an arbitrary (tilted) face plane, and open it */
  addSketchOnPlaneFrame: (frame: { origin: [number, number, number]; normal: [number, number, number]; xDir: [number, number, number] }) => void;
}

export interface NodeEditorProps {
  initialNodes: GeoNode[];
  initialEdges: Edge[];
  initialOutputId: string;
  onChange: (graph: Graph, outputId: string, pinnedIds: string[], userVars: Record<string, number>) => void;
  /** hands the parent an imperative handle once mounted */
  onReady?: (api: EditorApi) => void;
  /** fires when a single edge/face selection node is highlighted (or null) so the
   *  viewport can show what that selection targets on the live model */
  onSelectPreview?: (desc: { kind: "edge" | "face"; where: string; offset: number; near?: [number, number, number] } | null) => void;
  /** hover a selection-output port → highlight its geometry on the model */
  onPortHover?: (info: { nodeId: string; port: string } | null) => void;
  /** a modifier node (fillet/bevel/shell/internalThread) got selected → highlight
   *  the edges/faces it acts on (null clears) */
  onFeaturePreview?: (nodeId: string | null) => void;
  errorNodeId?: string | null;
  errorMessage?: string | null;
  values?: Record<string, string>;
  onExportSTL?: (graph: Graph, outputId: string) => void;
  onExport3MF?: () => void;
  onExportSVG?: (graph: Graph, outputId: string) => void;
  onExportDXF?: (graph: Graph, outputId: string) => void;
  onExportSTEP?: (graph: Graph, outputId: string) => void;
  onFit?: () => void;
  onTopView?: () => void;
  onExportPNG?: () => void;
}

let uid = 0;
const newId = (t: string) => `${t}_${++uid}`;
const round4 = (n: number) => (Number.isInteger(n) ? String(n) : (Math.round(n * 10000) / 10000).toString());

/** Build serialisable instance descriptors from React Flow nodes + edges. */
/** Comment/frame nodes carry no geometry — they never reach the graph engine. */
const isNote = (n: GeoNode) => n.data.nodeType === "__note";

function toGraph(nodes: GeoNode[], edges: Edge[]): InstanceDescriptor[] {
  return nodes.filter((n) => !isNote(n)).map<InstanceDescriptor>((n) => {
    const inputs: Record<string, string | string[]> = {};
    for (const e of edges) {
      if (e.target === n.id && e.targetHandle) {
        // encode a non-default source handle (selection output) as "src#handle"
        const ref = e.sourceHandle && e.sourceHandle !== "out" ? `${e.source}#${e.sourceHandle}` : e.source;
        const existing = inputs[e.targetHandle];
        // a port fed by several wires (multi-selection) accumulates into an array
        if (existing === undefined) inputs[e.targetHandle] = ref;
        else if (Array.isArray(existing)) existing.push(ref);
        else inputs[e.targetHandle] = [existing, ref];
      }
    }
    const d: InstanceDescriptor = { id: n.id, type: n.data.nodeType, params: n.data.params, inputs };
    if (n.data.component) d.component = n.data.component;
    return d;
  });
}

/** Stable string for change detection (ArrayBuffers reduced to a length tag). */
function graphSignature(graph: Graph, outputId: string): string {
  const norm = graph.map((n) => ({
    i: n.id,
    t: n.type,
    in: n.inputs,
    p: Object.fromEntries(
      Object.entries(n.params ?? {}).map(([k, v]) => [
        k,
        v instanceof ArrayBuffer ? `ab:${v.byteLength}` : v,
      ]),
    ),
  }));
  return JSON.stringify(norm) + "|" + outputId;
}

/* base64 ↔ ArrayBuffer for serialising file params (STL / fonts) */
function ab2b64(ab: ArrayBuffer): string {
  const b = new Uint8Array(ab);
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s);
}
function b642ab(s: string): ArrayBuffer {
  const bin = atob(s);
  const b = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
  return b.buffer;
}

interface SceneDoc {
  version?: number;
  title?: string;
  outputId: string;
  components?: Record<string, ComponentDef>;
  /** author-defined global parameters + which node params to surface in Simple mode */
  userParams?: UserParam[];
  exposed?: ExposedParam[];
  nodes: {
    id: string;
    type?: string; // React Flow node type ("geo" | "note"); defaults to "geo"
    position: { x: number; y: number };
    width?: number;
    height?: number;
    data: { nodeType: string; component?: string; alias?: string; params: Record<string, unknown> };
  }[];
  edges: Edge[];
}

/** Bundled example projects, loaded from examples/*.json at build time. */
const EXAMPLES = Object.entries(
  import.meta.glob("../examples/*.json", { eager: true, import: "default" }),
)
  .map(([path, doc]) => {
    const d = doc as SceneDoc;
    const name = path.split("/").pop()!.replace(/\.json$/, "");
    return { name, title: d.title ?? name, doc: d };
  })
  .sort((a, b) => a.title.localeCompare(b.title));

/* -------------------------------------------------------------------------- */
/* Graph persistence — survive a page reload (localStorage)                    */
/* -------------------------------------------------------------------------- */
const STORAGE_KEY = "nodal-maker-graph-v1";
const MODE_KEY = "nodal-maker-mode-v1";
interface UserParam { id: string; name: string; expr: string }
/** A node param the author surfaced to the Simple (form) view. */
interface ExposedParam { nodeId: string; param: string; label?: string }
interface SavedGraph { nodes: GeoNode[]; edges: Edge[]; outputId: string; userParams?: UserParam[]; exposed?: ExposedParam[] }

/** Resolve user parameters (in order, later ones may reference earlier) into a
 * flat name→number map for the evaluator. Bad expressions resolve to 0. */
function resolveUserParams(list: UserParam[]): Record<string, number> {
  const vars: Record<string, number> = {};
  for (const p of list) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(p.name)) continue;
    try { vars[p.name] = evalExpr(p.expr || "0", vars); } catch { vars[p.name] = 0; }
  }
  return vars;
}

function loadSavedGraph(): SavedGraph | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const g = JSON.parse(raw) as SavedGraph;
    if (!Array.isArray(g.nodes) || !Array.isArray(g.edges)) return null;
    return g;
  } catch {
    return null;
  }
}
function persistGraph(nodes: GeoNode[], edges: Edge[], outputId: string, userParams: UserParam[], exposed: ExposedParam[]) {
  try {
    // drop transient interaction flags so saves stay stable/small
    const clean = nodes.map((n) => ({ ...n, selected: false, dragging: false }));
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ nodes: clean, edges, outputId, userParams, exposed }));
  } catch {
    /* quota / serialization issues — non-fatal, just skip persistence */
  }
}

/** Resolve the ParamSpec for a node param (built-in node or component). */
function paramSpecOf(node: GeoNode, components: Record<string, ComponentDef>, name: string): ParamSpec | null {
  if (node.data.component) {
    const def = components[node.data.component];
    const p = def?.params.find((x) => x.name === name);
    return p ? ({ ...p.spec, name: p.name, label: p.label } as ParamSpec) : null;
  }
  return NODE_SPECS[node.data.nodeType]?.params.find((p) => p.name === name) ?? null;
}
function nodeDisplayLabel(node: GeoNode, components: Record<string, ComponentDef>): string {
  if (node.data.alias) return node.data.alias; // user-given name wins (Simple form)
  if (node.data.component) return components[node.data.component]?.name ?? "Component";
  return NODE_SPECS[node.data.nodeType]?.label ?? node.data.nodeType;
}

/**
 * The Simple (form) view: pick a model and tweak only the parameters the author
 * surfaced — global parameters + starred node params — with the live model on
 * the right. No nodes, no wiring. Expert mode reveals the full graph.
 */
function SimpleView({
  nodes, components, exposed, userParams, userVars, setParam, setUserParams, setExposed, applyDoc,
}: {
  nodes: GeoNode[];
  components: Record<string, ComponentDef>;
  exposed: ExposedParam[];
  userParams: UserParam[];
  userVars: Record<string, number>;
  setParam: (id: string, name: string, value: unknown) => void;
  setUserParams: React.Dispatch<React.SetStateAction<UserParam[]>>;
  setExposed: React.Dispatch<React.SetStateAction<ExposedParam[]>>;
  applyDoc: (doc: SceneDoc) => void;
}) {
  const empty = userParams.length === 0 && exposed.length === 0;
  return (
    <div className="simple">
      <div className="simple__card">
        <div className="simple__hd">⚙︎ Configurateur</div>
        <div className="simple__picklabel">Modèle</div>
        <div className="simple__gallery">
          {EXAMPLES.map((ex) => (
            <button
              key={ex.name}
              className="simple__tile"
              title={ex.title}
              onClick={() => applyDoc(ex.doc)}
            >
              <img className="simple__thumb" src={`${import.meta.env.BASE_URL}thumbs/${ex.name}.png`} alt="" loading="lazy" />
              <span className="simple__tilename">{ex.title.split(" — ")[0].split(" (")[0]}</span>
            </button>
          ))}
        </div>

        {empty ? (
          <div className="simple__empty">
            Ce modèle n'expose aucun paramètre.<br />
            Passe en <b>Expert</b> et clique l'étoile <span className="simple__star">☆</span> à côté d'un paramètre pour l'ajouter ici,
            ou ajoute des paramètres globaux (ƒ).
          </div>
        ) : (
          <div className="simple__params">
            {userParams.map((up) => (
              <label className="pf" key={up.id}>
                <span>{up.name}</span>
                <input
                  type="text" spellCheck={false} value={up.expr}
                  className={up.name in userVars ? undefined : "pf__expr"}
                  onChange={(e) => setUserParams((p) => p.map((x) => (x.id === up.id ? { ...x, expr: e.target.value } : x)))}
                />
              </label>
            ))}
            {exposed.map((ex) => {
              const node = nodes.find((n) => n.id === ex.nodeId);
              if (!node) return null;
              const spec = paramSpecOf(node, components, ex.param);
              if (!spec) return null;
              const label = ex.label ?? `${nodeDisplayLabel(node, components)} · ${spec.label ?? spec.name}`;
              return (
                <div className="simple__row" key={`${ex.nodeId}.${ex.param}`}>
                  <ParamField spec={{ ...spec, label }} value={node.data.params[ex.param]} onChange={(v) => setParam(ex.nodeId, ex.param, v)} />
                  <button
                    className="simple__rm" title="Retirer du formulaire"
                    onClick={() => setExposed((prev) => prev.filter((e) => !(e.nodeId === ex.nodeId && e.param === ex.param)))}
                  >×</button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

export default function NodeEditor({
  initialNodes,
  initialEdges,
  initialOutputId,
  onChange,
  onReady,
  onSelectPreview,
  onPortHover,
  onFeaturePreview,
  errorNodeId,
  errorMessage,
  values,
  onExportSTL,
  onExport3MF,
  onExportSVG,
  onExportDXF,
  onExportSTEP,
  onFit,
  onTopView,
  onExportPNG,
}: NodeEditorProps) {
  // restore a previously-saved graph (once), else fall back to the seed
  const savedRef = useRef<SavedGraph | null | undefined>(undefined);
  if (savedRef.current === undefined) savedRef.current = loadSavedGraph();
  const saved = savedRef.current;
  const [nodes, setNodes, onNodesChange] = useNodesState<GeoNode>(saved?.nodes ?? initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(saved?.edges ?? initialEdges);
  const [outputId, setOutputId] = useState(saved?.outputId ?? initialOutputId);
  const [userParams, setUserParams] = useState<UserParam[]>(saved?.userParams ?? []);
  const userVars = useMemo(() => resolveUserParams(userParams), [userParams]);
  // author-exposed node params (drive the Simple form) + Simple/Expert view mode
  const [exposed, setExposed] = useState<ExposedParam[]>(saved?.exposed ?? []);
  const [mode, setMode] = useState<"simple" | "expert">(() => {
    // Simple (form) is the default; only an explicit stored choice opts into Expert
    try { return localStorage.getItem(MODE_KEY) === "expert" ? "expert" : "simple"; } catch { return "simple"; }
  });
  useEffect(() => { try { localStorage.setItem(MODE_KEY, mode); } catch { /* ignore */ } }, [mode]);
  const isExposed = useCallback((nodeId: string, param: string) => exposed.some((e) => e.nodeId === nodeId && e.param === param), [exposed]);
  const toggleExpose = useCallback((nodeId: string, param: string) => {
    setExposed((prev) => prev.some((e) => e.nodeId === nodeId && e.param === param)
      ? prev.filter((e) => !(e.nodeId === nodeId && e.param === param))
      : [...prev, { nodeId, param }]);
  }, []);

  // persist the graph on change (debounced) so a reload keeps the work
  const saveTimer = useRef<number | undefined>(undefined);
  useEffect(() => {
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => persistGraph(nodes, edges, outputId, userParams, exposed), 400);
    return () => window.clearTimeout(saveTimer.current);
  }, [nodes, edges, outputId, userParams, exposed]);

  // Visibility is opt-OUT: every body is shown by default. Independent bodies
  // (not in the viewed node's own build chain) render translucent alongside the
  // opaque viewed node, so several B-reps can be seen together (bolt + nut).
  // `hidden` holds the nodes the user explicitly turned off.
  // 2D sketch editor overlay: which Sketch node is being edited (null = closed)
  const [editingSketchId, setEditingSketchId] = useState<string | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const toggleVisible = useCallback((id: string) => {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const rf = useRef<ReactFlowInstance<GeoNode, Edge> | null>(null);
  const [search, setSearch] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  // quick-add popup. `connect` is set when the popup was opened by dropping a
  // dangling wire on empty canvas → the picked node is auto-wired to that port.
  type ConnectDrag = { nodeId: string; handleId: string; handleType: "source" | "target"; socketType: SocketType };
  const [quick, setQuick] = useState<{ sx: number; sy: number; flow: { x: number; y: number }; q: string; connect?: ConnectDrag } | null>(null);
  const connectStart = useRef<{ nodeId: string; handleId: string; handleType: "source" | "target" } | null>(null);
  const [components, setComponents] = useState<Record<string, ComponentDef>>({});
  // timeline: show only construction steps (geometry) by default, hiding helper
  // nodes (selections, numbers, text, math) that merely parametrise them.
  const [showHelpers, setShowHelpers] = useState(false);
  // palette hover tooltip: which node type + the vertical anchor (screen y)
  const [tip, setTip] = useState<{ type: string; y: number } | null>(null);
  // port hover tooltip: socket type + cursor position
  const [portTip, setPortTip] = useState<{ type: SocketType; x: number; y: number } | null>(null);

  // socket type of a node's output handle (main "out" or a selection output)
  const nodeOutType = useCallback(
    (n: GeoNode, handle: string = "out"): SocketType | undefined => {
      if (handle !== "out") {
        // a selection output port is edge- or face-typed by its target; forward
        // nodes (transform…) re-expose their input's ports, so follow the chain
        const targetOf = (node: GeoNode): "edge" | "face" | undefined => {
          const so = NODE_SPECS[node.data.nodeType]?.selectionOutputs?.find((o) => o.name === handle);
          if (so) return so.target;
          if (FORWARD_SEL.has(node.data.nodeType)) {
            const e = edges.find((ed) => ed.target === node.id && ed.targetHandle === "in");
            const src = e && nodes.find((x) => x.id === e.source);
            if (src) return targetOf(src);
          }
          return undefined;
        };
        const t = targetOf(n);
        return t === "edge" ? "edgeSel" : t === "face" ? "faceSel" : undefined;
      }
      return n.data.component ? components[n.data.component]?.outputType : NODE_SPECS[n.data.nodeType]?.output;
    },
    [components, nodes, edges],
  );
  const nodeInType = useCallback(
    (n: GeoNode, handle: string): SocketType | undefined => {
      if (n.data.component) return components[n.data.component]?.inputs.find((i) => i.name === handle)?.type;
      // a Sketch node's dynamic dimension handles accept numbers
      if (n.data.nodeType === "sketch" && n.data.params.doc) {
        const doc = n.data.params.doc as SketchDoc;
        if (dimensions(doc).some((dm) => dm.name === handle)) return "number";
      }
      return handleType(n.data.nodeType, handle);
    },
    [components],
  );

  // undo/redo: snapshots of {nodes, edges, outputId}. `applying` suppresses
  // history recording while we replay a snapshot; `prevSnap` always mirrors the
  // latest committed state (positions included) so undo doesn't lose node moves.
  type Snapshot = { nodes: GeoNode[]; edges: Edge[]; outputId: string };
  const undoStack = useRef<Snapshot[]>([]);
  const redoStack = useRef<Snapshot[]>([]);
  const applying = useRef(false);
  const prevSnap = useRef<Snapshot>({
    nodes: initialNodes,
    edges: initialEdges,
    outputId: initialOutputId,
  });
  const [histLen, setHistLen] = useState({ undo: 0, redo: 0 });

  // Single source of emission: whenever the graph's *topology or params* change
  // (drags don't count), emit a fresh graph. This makes add / delete / connect /
  // param-edit all flow through one path, and deletion works for free.
  const lastSig = useRef<string>("");
  useEffect(() => {
    const geoNodes = nodes.filter((n) => !isNote(n));
    const validOut = nodes.some((n) => n.id === outputId && !isNote(n))
      ? outputId
      : (geoNodes[geoNodes.length - 1]?.id ?? "");
    if (validOut !== outputId) {
      setOutputId(validOut); // output node was deleted → fall back, re-runs effect
      return;
    }
    const descs = toGraph(nodes, edges);
    // expand component instances into a flat graph for the evaluator
    const flat = expandDescriptors(descs, components);
    const flatOut = expandOutputId(validOut, descs, components);

    // the viewed node's own build chain (its ancestors + descendants). These are
    // stages of the *same* body, so we don't draw them on top of the output —
    // only independent bodies show translucent alongside it.
    const lineage = new Set<string>([validOut]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const e of edges) {
        if (lineage.has(e.target) && !lineage.has(e.source)) { lineage.add(e.source); grew = true; }
        if (lineage.has(e.source) && !lineage.has(e.target)) { lineage.add(e.target); grew = true; }
      }
    }
    // extra bodies: only *terminal* nodes (no outgoing edge) render as separate
    // bodies — an intermediate stage is already represented by its downstream
    // result, so drawing it too would stack duplicates. Also drop the output,
    // its lineage, hidden nodes, and stale/note nodes.
    const hasOutgoing = new Set(edges.map((e) => e.source));
    const flatPins = nodes
      .filter(
        (n) =>
          !isNote(n) &&
          n.id !== validOut &&
          !hidden.has(n.id) &&
          !lineage.has(n.id) &&
          !hasOutgoing.has(n.id),
      )
      .map((n) => expandOutputId(n.id, descs, components))
      .filter((fid) => fid !== flatOut);
    const varsSig = Object.keys(userVars).sort().map((k) => `${k}=${userVars[k]}`).join(";");
    const sig = graphSignature(flat, flatOut) + "|pins:" + flatPins.slice().sort().join(",") + "|vars:" + varsSig;
    if (sig !== lastSig.current) {
      const isFirst = lastSig.current === "";
      if (!applying.current && !isFirst) {
        undoStack.current.push(prevSnap.current);
        if (undoStack.current.length > 100) undoStack.current.shift();
        redoStack.current = [];
        setHistLen({ undo: undoStack.current.length, redo: 0 });
      }
      applying.current = false;
      lastSig.current = sig;
      onChange(flat, flatOut, flatPins, userVars);
    }
    prevSnap.current = { nodes, edges, outputId: validOut };
  }, [nodes, edges, outputId, onChange, components, hidden, userVars]);

  // Preview what a selection node targets: when exactly one edge/face selection
  // node is highlighted, hand its descriptor to the parent (→ viewport overlay).
  const onSelectPreviewRef = useRef(onSelectPreview);
  onSelectPreviewRef.current = onSelectPreview;
  const onFeaturePreviewRef = useRef(onFeaturePreview);
  onFeaturePreviewRef.current = onFeaturePreview;
  const lastPreviewSig = useRef<string>("");
  const lastFeatureSig = useRef<string>("");
  const FEATURE_NODES = useMemo(() => new Set(["fillet", "bevel", "shell", "internalThread"]), []);
  useEffect(() => {
    const sel = nodes.filter((n) => n.selected && !isNote(n));
    const one = sel.length === 1 ? sel[0] : null;
    const t = one?.data.nodeType;
    // (a) an Edge/Face Select node → descriptor preview of its own selection
    let desc: { kind: "edge" | "face"; where: string; offset: number; near?: [number, number, number] } | null = null;
    if (one && (t === "edgeSelect" || t === "faceSelect")) {
      const p = one.data.params ?? {};
      const near = Array.isArray(p.near) && p.near.length === 3 ? (p.near.map(Number) as [number, number, number]) : undefined;
      desc = { kind: t === "faceSelect" ? "face" : "edge", where: String(p.where ?? "all"), offset: Number(p.offset ?? 0), near };
    }
    const sig = JSON.stringify(desc);
    if (sig !== lastPreviewSig.current) { lastPreviewSig.current = sig; onSelectPreviewRef.current?.(desc); }
    // (b) a modifier node → highlight the edges/faces it acts on
    const featNode = one && !one.data.component && t && FEATURE_NODES.has(t) ? one.id : null;
    if ((featNode ?? "") !== lastFeatureSig.current) { lastFeatureSig.current = featNode ?? ""; onFeaturePreviewRef.current?.(featNode); }
  }, [nodes, FEATURE_NODES]);

  const undo = useCallback(() => {
    const snap = undoStack.current.pop();
    if (!snap) return;
    redoStack.current.push(prevSnap.current);
    applying.current = true;
    setNodes(snap.nodes);
    setEdges(snap.edges);
    setOutputId(snap.outputId);
    setHistLen({ undo: undoStack.current.length, redo: redoStack.current.length });
  }, [setNodes, setEdges]);

  const redo = useCallback(() => {
    const snap = redoStack.current.pop();
    if (!snap) return;
    undoStack.current.push(prevSnap.current);
    applying.current = true;
    setNodes(snap.nodes);
    setEdges(snap.edges);
    setOutputId(snap.outputId);
    setHistLen({ undo: undoStack.current.length, redo: redoStack.current.length });
  }, [setNodes, setEdges]);

  // copy / paste / duplicate of the current selection (+ internal edges)
  const clipboard = useRef<{ nodes: GeoNode[]; edges: Edge[] } | null>(null);
  const copySelection = useCallback(() => {
    const sel = nodes.filter((n) => n.selected);
    if (!sel.length) return false;
    const ids = new Set(sel.map((n) => n.id));
    clipboard.current = {
      nodes: sel.map((n) => ({ ...n, data: { ...n.data, params: { ...n.data.params } } })),
      edges: edges.filter((e) => ids.has(e.source) && ids.has(e.target)),
    };
    return true;
  }, [nodes, edges]);
  const pasteClipboard = useCallback(() => {
    const cb = clipboard.current;
    if (!cb) return;
    const idMap = new Map<string, string>();
    cb.nodes.forEach((n) => idMap.set(n.id, newId(n.data.nodeType)));
    const newNodes: GeoNode[] = cb.nodes.map((n) => ({
      ...n,
      id: idMap.get(n.id)!,
      selected: true,
      position: { x: n.position.x + 32, y: n.position.y + 32 },
      data: { ...n.data, params: { ...n.data.params } },
    }));
    const newEdges: Edge[] = cb.edges.map((e) => ({
      ...e,
      id: newId("e"),
      source: idMap.get(e.source)!,
      target: idMap.get(e.target)!,
    }));
    setNodes((prev) => [...prev.map((n) => ({ ...n, selected: false })), ...newNodes]);
    setEdges((prev) => [...prev, ...newEdges]);
  }, [setNodes, setEdges]);
  const duplicateSelection = useCallback(() => {
    if (copySelection()) pasteClipboard();
  }, [copySelection, pasteClipboard]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // the sketch editor overlay owns the keyboard while it's open
      if (editingSketchId) return;
      const t = e.target as HTMLElement | null;
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (mod && e.key.toLowerCase() === "c") {
        copySelection();
      } else if (mod && e.key.toLowerCase() === "v") {
        e.preventDefault();
        pasteClipboard();
      } else if (mod && e.key.toLowerCase() === "d") {
        e.preventDefault();
        duplicateSelection();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo, copySelection, pasteClipboard, duplicateSelection, editingSketchId]);

  const isValidConnection = useCallback(
    (c: Connection | Edge) => {
      if (!c.source || !c.target || !c.targetHandle || c.source === c.target) return false;
      const src = nodes.find((n) => n.id === c.source);
      const tgt = nodes.find((n) => n.id === c.target);
      if (!src || !tgt) return false;
      const out = nodeOutType(src, c.sourceHandle ?? "out");
      const inp = nodeInType(tgt, c.targetHandle);
      return !!out && !!inp && (out === inp || (out === "solid" && inp === "mesh"));
    },
    [nodes, nodeOutType, nodeInType],
  );

  const setParam = useCallback(
    (id: string, name: string, value: unknown) => {
      setNodes((prev) =>
        prev.map((n) =>
          n.id === id
            ? { ...n, data: { ...n.data, params: { ...n.data.params, [name]: value } } }
            : n,
        ),
      );
    },
    [setNodes],
  );

  const setOutput = useCallback((id: string) => setOutputId(id), []);
  const setAlias = useCallback((id: string, alias: string) => {
    setNodes((prev) => prev.map((n) => (n.id === id ? { ...n, data: { ...n.data, alias: alias || undefined } } : n)));
  }, [setNodes]);

  const editSketch = useCallback((id: string) => setEditingSketchId(id), []);
  /**
   * Commit an edited sketch back onto its node: store the doc and refresh the
   * mirrored driving-dimension params (add new, drop removed) so the node's
   * editable fields and the live re-solve stay in sync with the drawing.
   */
  const commitSketch = useCallback((id: string, doc: SketchDoc) => {
    setNodes((prev) =>
      prev.map((n) => {
        if (n.id !== id) return n;
        const params: Record<string, unknown> = { ...n.data.params, doc, plane: doc.plane };
        const dims = dimensions(doc);
        const names = new Set(dims.map((x) => x.name));
        // drop params for dimensions that no longer exist
        for (const k of Object.keys(params)) {
          if (k !== "doc" && k !== "plane" && !names.has(k) && /^[dra]\d+$/.test(k)) delete params[k];
        }
        // the editor is authoritative on exit: mirror every dimension's value
        for (const dm of dims) params[dm.name] = dm.value;
        return { ...n, data: { ...n.data, params } };
      }),
    );
  }, [setNodes]);

  // create a Face/Edge Select node from a viewport pick, and — if the currently
  // viewed node is a fillet/bevel/shell with an empty selection port of the
  // matching kind — auto-wire the new selector straight into it.
  const addSelectFromPick = useCallback(
    (kind: "face" | "edge", where: string, offset: number, near?: [number, number, number], box?: number[], ref?: unknown) => {
      const nodeType = kind === "face" ? "faceSelect" : "edgeSelect";
      const id = newId(nodeType);
      const params: Record<string, unknown> = {};
      for (const p of NODE_SPECS[nodeType].params) params[p.name] = p.default;
      params.where = where;
      params.offset = offset;
      if (near) params.near = near; // isolate a single border loop (not shown in the panel)
      if (box) params.box = box; // isolate a single face by its AABB (e.g. one bore)
      if (ref) params.ref = ref; // bbox-relative signature → parametric re-bind on change

      const CONSUMERS: Record<string, { port: string; need: "face" | "edge" }> = {
        fillet: { port: "sel", need: "edge" },
        bevel: { port: "sel", need: "edge" },
        shell: { port: "faces", need: "face" },
        internalThread: { port: "face", need: "face" },
      };
      const consumerOf = (n: GeoNode | undefined) =>
        n && !n.data.component ? CONSUMERS[n.data.nodeType] : undefined;
      const portFree = (nid: string, port: string) =>
        !edges.some((e) => e.target === nid && e.targetHandle === port);

      // Auto-wire target: the viewed node if it's a matching consumer with a free
      // port; otherwise a consumer directly downstream of the viewed node (you
      // pick edges on the sharp base body and they feed its fillet/shell). In the
      // latter case, switch the view to the consumer so the result is shown.
      const viewed = nodes.find((n) => n.id === outputId);
      let wire: { target: string; port: string } | null = null;
      let switchView: string | null = null;
      const vc = consumerOf(viewed);
      if (viewed && vc && vc.need === kind && portFree(viewed.id, vc.port)) {
        wire = { target: viewed.id, port: vc.port };
      } else {
        for (const n of nodes) {
          const c = consumerOf(n);
          if (!c || c.need !== kind || !portFree(n.id, c.port)) continue;
          const feedsFromViewed = edges.some(
            (e) => e.target === n.id && e.targetHandle === "in" && e.source === outputId,
          );
          if (feedsFromViewed) { wire = { target: n.id, port: c.port }; switchView = n.id; break; }
        }
      }

      const anchor = viewed ?? nodes[nodes.length - 1];
      const position = anchor
        ? { x: anchor.position.x - 30, y: anchor.position.y + 190 }
        : { x: 80, y: 220 };
      setNodes((prev) => [
        ...prev.map((n) => ({ ...n, selected: false })),
        { id, type: "geo", position, selected: true, data: { nodeType, params } },
      ]);
      if (wire) {
        setEdges((es) =>
          addEdge(
            { source: id, sourceHandle: "out", target: wire.target, targetHandle: wire.port, style: { stroke: SOCKET_COLORS[kind === "face" ? "faceSel" : "edgeSel"] } },
            es,
          ),
        );
        if (switchView) setOutputId(switchView);
      }
    },
    [nodes, edges, outputId, setNodes, setEdges],
  );

  const addFaceSelect = useCallback((where: string, offset: number, box?: number[], ref?: unknown) => addSelectFromPick("face", where, offset, undefined, box, ref), [addSelectFromPick]);
  const addEdgeSelect = useCallback((where: string, offset: number, near?: [number, number, number], ref?: unknown) => addSelectFromPick("edge", where, offset, near, undefined, ref), [addSelectFromPick]);

  const addSketchOnPlane = useCallback((base: "XY" | "XZ" | "YZ", offset: number, reference?: [number, number][][]) => {
    // seed with the face outline as reference geometry when available, else a
    // starter rectangle to draw on
    const doc = reference && reference.length ? docFromReference(base, offset, reference) : starterRect();
    doc.plane = base;
    doc.planeOffset = offset;
    const params: Record<string, unknown> = { plane: base, doc };
    for (const dim of dimensions(doc)) params[dim.name] = dim.value;
    const nid = newId("sketch");
    const sel = nodes.find((n) => n.selected);
    const position = sel ? { x: sel.position.x, y: sel.position.y + 200 } : { x: 80, y: 80 };
    setNodes((prev) => [...prev.map((n) => ({ ...n, selected: false })), { id: nid, type: "geo", position, selected: true, data: { nodeType: "sketch", params } }]);
    setEditingSketchId(nid); // jump straight into the 2D editor
  }, [nodes, setNodes]);

  const addSketchOnPlaneFrame = useCallback((frame: { origin: [number, number, number]; normal: [number, number, number]; xDir: [number, number, number] }) => {
    // tilted face → local 2D frame; keep base plane "XY" (the frame overrides it)
    const doc = starterRect();
    doc.frame = frame;
    const params: Record<string, unknown> = { plane: "XY", doc };
    for (const dim of dimensions(doc)) params[dim.name] = dim.value;
    const nid = newId("sketch");
    const sel = nodes.find((n) => n.selected);
    const position = sel ? { x: sel.position.x, y: sel.position.y + 200 } : { x: 80, y: 80 };
    setNodes((prev) => [...prev.map((n) => ({ ...n, selected: false })), { id: nid, type: "geo", position, selected: true, data: { nodeType: "sketch", params } }]);
    setEditingSketchId(nid);
  }, [nodes, setNodes]);

  useEffect(() => {
    onReady?.({ setParam, addFaceSelect, addEdgeSelect, addSketchOnPlane, addSketchOnPlaneFrame });
  }, [onReady, setParam, addFaceSelect, addEdgeSelect, addSketchOnPlane, addSketchOnPlaneFrame]);

  const onConnect = useCallback(
    (c: Connection) => {
      const src = nodes.find((n) => n.id === c.source);
      const tgt = nodes.find((n) => n.id === c.target);
      if (!src || !tgt || !c.targetHandle) return;
      const outType = nodeOutType(src, c.sourceHandle ?? "out");
      const inType = nodeInType(tgt, c.targetHandle);
      if (!outType || !inType) return;

      // one input port takes at most one wire — EXCEPT selection ports, which
      // accept several (a fillet/shell targets the union of several selections)
      const freed = inType === "edgeSel" || inType === "faceSel"
        ? edges
        : edges.filter((e) => !(e.target === tgt.id && e.targetHandle === c.targetHandle));

      if (outType === inType) {
        setEdges(addEdge({ ...c, style: { stroke: SOCKET_COLORS[outType] } }, freed));
        return;
      }
      // the one useful implicit coercion: B-rep solid → mesh, via tessellate
      if (outType === "solid" && inType === "mesh") {
        const tessId = newId("tessellate");
        const tess: GeoNode = {
          id: tessId,
          type: "geo",
          position: {
            x: (src.position.x + tgt.position.x) / 2,
            y: (src.position.y + tgt.position.y) / 2 + 20,
          },
          data: { nodeType: "tessellate", params: {} },
        };
        setNodes((ns) => [...ns, tess]);
        setEdges([
          ...freed,
          { id: newId("e"), source: src.id, sourceHandle: "out", target: tessId, targetHandle: "in", style: { stroke: SOCKET_COLORS.solid } },
          { id: newId("e"), source: tessId, sourceHandle: "out", target: tgt.id, targetHandle: c.targetHandle, style: { stroke: SOCKET_COLORS.mesh } },
        ]);
      }
      // otherwise: incompatible types, silently ignore
    },
    [nodes, edges, setEdges, setNodes, nodeOutType, nodeInType],
  );

  const addNode = useCallback(
    (type: string, opts?: { position?: { x: number; y: number }; autoConnect?: boolean }) => {
      const spec = NODE_SPECS[type];
      const params: Record<string, unknown> = {};
      for (const p of spec.params) params[p.name] = p.default;
      // a fresh Sketch node starts as a fully-constrained rectangle whose
      // width/height dimensions are mirrored as editable node params
      if (type === "sketch") {
        const doc = starterRect();
        params.doc = doc;
        for (const dim of dimensions(doc)) params[dim.name] = dim.value;
      }
      const id = newId(type);
      const sel = nodes.find((n) => n.selected);
      const position =
        opts?.position ??
        (sel ? { x: sel.position.x + 240, y: sel.position.y } : { x: 60 + Math.random() * 60, y: 60 + Math.random() * 180 });
      setNodes((prev) => [...prev.map((n) => ({ ...n, selected: false })), { id, type: "geo", position, selected: true, data: { nodeType: type, params } }]);

      // auto-connect from the selected node's output → first compatible input
      const outType = sel ? nodeOutType(sel) : undefined;
      if ((opts?.autoConnect ?? true) && sel && outType) {
        const port =
          spec.inputs.find((p) => p.type === outType)?.name ??
          spec.params.map((p) => [p.name, paramPortType(p)] as const).find(([, t]) => t === outType)?.[0];
        if (port) {
          setEdges((es) =>
            addEdge(
              { source: sel.id, sourceHandle: "out", target: id, targetHandle: port, style: { stroke: SOCKET_COLORS[outType] } },
              es,
            ),
          );
        }
      }
    },
    [nodes, setNodes, setEdges, nodeOutType],
  );

  // drop a free-floating comment/frame node (visual only, never evaluated).
  // placed just ABOVE the current node (empty space) and appended so it renders
  // on top and stays clickable even over other nodes.
  const addNote = useCallback(() => {
    const id = newId("note");
    const sel = nodes.find((n) => n.selected);
    // default: centre of the visible canvas (so it's never dropped off-screen)
    let position = { x: 40, y: 40 };
    if (sel) position = { x: sel.position.x, y: sel.position.y - 110 };
    else {
      const pane = document.querySelector(".editor__canvas");
      const rect = pane?.getBoundingClientRect();
      if (rect && rf.current)
        position = rf.current.screenToFlowPosition({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
    }
    setNodes((prev) => [
      ...prev.map((n) => ({ ...n, selected: false })),
      // explicit width/height so React Flow renders it immediately (it hides
      // custom nodes until measured, and a note has no ports to force a size)
      { id, type: "note", position, width: 190, height: 80, selected: true, data: { nodeType: "__note", params: { text: "" } } },
    ]);
  }, [nodes, setNodes]);

  // group the current selection into a reusable component instance
  const collapseSelection = useCallback(() => {
    const sel = nodes.filter((n) => n.selected && !n.data.component); // no nesting (MVP)
    if (sel.length < 2) return;
    const ids = new Set(sel.map((n) => n.id));
    const internal = edges.filter((e) => ids.has(e.source) && ids.has(e.target));
    const inbound = edges.filter((e) => !ids.has(e.source) && ids.has(e.target));
    const outbound = edges.filter((e) => ids.has(e.source) && !ids.has(e.target));
    const internalTargets = new Set(internal.map((e) => `${e.target}.${e.targetHandle}`));

    const outputNode =
      (outbound[0] && sel.find((n) => n.id === outbound[0].source)) ||
      (ids.has(outputId) ? sel.find((n) => n.id === outputId) : undefined) ||
      sel[sel.length - 1];

    const innerNodes = sel.map((n) => {
      const inputs: Record<string, string> = {};
      for (const e of internal) if (e.target === n.id && e.targetHandle) inputs[e.targetHandle] = e.source;
      return { id: n.id, type: n.data.nodeType, params: { ...n.data.params }, inputs };
    });

    const defInputs: ComponentDef["inputs"] = [];
    const instInputWires: Record<string, string> = {};
    const seenIn = new Set<string>();
    for (const e of inbound) {
      if (!e.targetHandle) continue;
      const key = `${e.target}.${e.targetHandle}`;
      if (seenIn.has(key)) continue;
      seenIn.add(key);
      const tgt = sel.find((n) => n.id === e.target)!;
      const type = nodeInType(tgt, e.targetHandle);
      if (!type) continue;
      const name = `${NODE_SPECS[tgt.data.nodeType]?.label ?? "in"} ${e.targetHandle}`;
      defInputs.push({ name, type, node: e.target, nodePort: e.targetHandle });
      instInputWires[name] = e.source;
    }

    const defParams: ComponentDef["params"] = [];
    const instParams: Record<string, unknown> = {};
    for (const n of sel) {
      const s = NODE_SPECS[n.data.nodeType];
      if (!s) continue;
      for (const ps of s.params) {
        if (ps.kind === "stl" || ps.kind === "font") continue;
        if (internalTargets.has(`${n.id}.${ps.name}`)) continue;
        const name = `${s.label} ${ps.label ?? ps.name}`;
        defParams.push({ name, label: name, node: n.id, param: ps.name, spec: ps });
        instParams[name] = n.data.params[ps.name] ?? ps.default;
      }
    }

    const defId = newId("def");
    const def: ComponentDef = {
      name: "Component",
      nodes: innerNodes,
      inputs: defInputs,
      params: defParams,
      output: outputNode.id,
      outputType: nodeOutType(outputNode) ?? "solid",
    };
    setComponents((prev) => ({ ...prev, [defId]: def }));

    const cx = sel.reduce((s, n) => s + n.position.x, 0) / sel.length;
    const cy = sel.reduce((s, n) => s + n.position.y, 0) / sel.length;
    const instId = newId("component");
    const instance: GeoNode = {
      id: instId,
      type: "geo",
      position: { x: cx, y: cy },
      selected: true,
      data: { nodeType: "__component", component: defId, params: instParams },
    };

    const keptNodes = nodes.filter((n) => !ids.has(n.id)).map((n) => ({ ...n, selected: false }));
    const keptEdges = edges.filter((e) => !ids.has(e.source) && !ids.has(e.target));
    const newEdges: Edge[] = [...keptEdges];
    for (const [name, src] of Object.entries(instInputWires)) {
      const t = defInputs.find((i) => i.name === name)!;
      newEdges.push({ id: newId("e"), source: src, sourceHandle: "out", target: instId, targetHandle: name, style: { stroke: SOCKET_COLORS[t.type] } });
    }
    for (const e of outbound) {
      if (e.source !== outputNode.id) continue; // only the exposed output survives
      newEdges.push({ ...e, id: newId("e"), source: instId, sourceHandle: "out" });
    }

    setNodes([...keptNodes, instance]);
    setEdges(newEdges);
    if (ids.has(outputId)) setOutputId(instId);
  }, [nodes, edges, outputId, nodeInType, nodeOutType, setNodes, setEdges]);

  const saveGraph = useCallback(() => {
    const payload = {
      version: 2,
      outputId,
      components,
      nodes: nodes.map((n) => ({
        id: n.id,
        type: n.type,
        position: n.position,
        width: n.width ?? undefined,
        height: n.height ?? undefined,
        data: {
          nodeType: n.data.nodeType,
          component: n.data.component,
          alias: n.data.alias,
          params: Object.fromEntries(
            Object.entries(n.data.params).map(([k, v]) => [
              k,
              v instanceof ArrayBuffer ? { __ab: ab2b64(v) } : v,
            ]),
          ),
        },
      })),
      edges: edges.map((e) => ({
        id: e.id, source: e.source, sourceHandle: e.sourceHandle,
        target: e.target, targetHandle: e.targetHandle,
        style: e.style,
      })),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "scene.json";
    a.click();
    URL.revokeObjectURL(url);
  }, [nodes, edges, outputId, components]);

  const applyDoc = useCallback(
    (doc: SceneDoc) => {
      const loadedNodes: GeoNode[] = doc.nodes.map((n) => ({
        id: n.id,
        type: n.type ?? "geo",
        position: n.position,
        ...(n.width ? { width: n.width } : {}),
        ...(n.height ? { height: n.height } : {}),
        data: {
          nodeType: n.data.nodeType,
          component: n.data.component,
          alias: n.data.alias,
          params: Object.fromEntries(
            Object.entries(n.data.params).map(([k, v]) => [
              k,
              v && typeof v === "object" && "__ab" in v ? b642ab((v as { __ab: string }).__ab) : v,
            ]),
          ),
        },
      }));
      lastSig.current = ""; // force re-emit
      setComponents((doc.components ?? {}) as Record<string, ComponentDef>);
      setNodes(loadedNodes);
      setEdges(doc.edges as Edge[]);
      setOutputId(doc.outputId);
      // adopt the example's exposed form (falls back to empty)
      setUserParams(doc.userParams ?? []);
      setExposed(doc.exposed ?? []);
    },
    [setNodes, setEdges],
  );

  const loadGraph = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const f = e.target.files?.[0];
      if (!f) return;
      applyDoc(JSON.parse(await f.text()) as SceneDoc);
      e.target.value = ""; // allow re-loading the same file
    },
    [applyDoc],
  );

  // which (source node, source handle) pairs drive an outgoing wire — lets the
  // selection-outputs accordion keep connected ports visible when collapsed.
  const sourceLinkedSet = useMemo(() => {
    const s = new Set<string>();
    for (const e of edges) if (e.sourceHandle) s.add(`${e.source} ${e.sourceHandle}`);
    return s;
  }, [edges]);

  // which (node, port) targets currently have an incoming wire
  const linkedSet = useMemo(() => {
    const s = new Set<string>();
    for (const e of edges) if (e.targetHandle) s.add(`${e.target} ${e.targetHandle}`);
    return s;
  }, [edges]);

  // effective selection outputs per node: a leaf's own ports, or — for a
  // transform-family node — the ports of whatever feeds its `in`, walked back
  // through the chain so a downstream pick tracks the moved geometry.
  const selOutputsMap = useMemo(() => {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const compute = (node: GeoNode, depth: number): SelOut[] => {
      if (depth > 16) return [];
      const own = node.data.component ? undefined : NODE_SPECS[node.data.nodeType]?.selectionOutputs;
      if (own?.length) return own;
      if (FORWARD_SEL.has(node.data.nodeType)) {
        const e = edges.find((ed) => ed.target === node.id && ed.targetHandle === "in");
        const src = e ? byId.get(e.source) : undefined;
        return src ? compute(src, depth + 1) : [];
      }
      return [];
    };
    const m = new Map<string, SelOut[]>();
    for (const n of nodes) m.set(n.id, compute(n, 0));
    return m;
  }, [nodes, edges]);

  // history timeline order = GENERATION order (topological): sources first, each
  // node after every node it depends on, ending at the final result — not the
  // raw order nodes were added. Independent branches keep their array order.
  const timelineOrder = useMemo(() => {
    const geo = nodes.filter((n) => !isNote(n));
    const idx = new Map(geo.map((n, i) => [n.id, i]));
    const ids = new Set(geo.map((n) => n.id));
    const indeg = new Map(geo.map((n) => [n.id, 0]));
    const dependents = new Map<string, string[]>(geo.map((n) => [n.id, []]));
    const counted = new Set<string>(); // dedupe multi-edges between same pair
    for (const e of edges) {
      if (!ids.has(e.source) || !ids.has(e.target) || e.source === e.target) continue;
      const key = `${e.source}->${e.target}`;
      if (counted.has(key)) continue;
      counted.add(key);
      indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1);
      dependents.get(e.source)!.push(e.target);
    }
    const result: GeoNode[] = [];
    const done = new Set<string>();
    const byId = new Map(geo.map((n) => [n.id, n]));
    const bySmallestIdx = (a: string, b: string) => (idx.get(a) ?? 0) - (idx.get(b) ?? 0);
    const ready = geo.filter((n) => (indeg.get(n.id) ?? 0) === 0).map((n) => n.id);
    while (result.length < geo.length) {
      let pick: string | undefined;
      if (ready.length) {
        ready.sort(bySmallestIdx);
        pick = ready.shift();
      } else {
        // cycle guard (shouldn't happen in a DAG): take the smallest-index leftover
        pick = geo.filter((n) => !done.has(n.id)).sort((a, b) => bySmallestIdx(a.id, b.id))[0]?.id;
      }
      if (pick == null) break;
      done.add(pick);
      result.push(byId.get(pick)!);
      for (const t of dependents.get(pick)!) {
        indeg.set(t, (indeg.get(t) ?? 1) - 1);
        if ((indeg.get(t) ?? 0) === 0 && !done.has(t)) ready.push(t);
      }
    }
    return result;
  }, [nodes, edges]);

  const onPortHoverRef = useRef(onPortHover);
  onPortHoverRef.current = onPortHover;
  const hoverPort = useCallback((nodeId: string, port: string) => onPortHoverRef.current?.({ nodeId, port }), []);
  const clearHoverPort = useCallback(() => onPortHoverRef.current?.(null), []);

  const ctx = useMemo<EditorCtx>(
    () => ({
      outputId,
      setOutput,
      setParam,
      isLinked: (nodeId, port) => linkedSet.has(`${nodeId} ${port}`),
      errorNodeId: errorNodeId ?? null,
      errorMessage: errorMessage ?? null,
      valueOf: (nodeId) => values?.[nodeId],
      componentDef: (defId) => components[defId],
      selOutputs: (nodeId) => selOutputsMap.get(nodeId) ?? [],
      isSourceLinked: (nodeId, handle) => sourceLinkedSet.has(`${nodeId} ${handle}`),
      setPortTip,
      isVisible: (nodeId) => !hidden.has(nodeId),
      toggleVisible,
      editSketch,
      isExposed,
      toggleExpose,
      setAlias,
      hoverPort,
      clearHoverPort,
    }),
    [outputId, setOutput, setParam, linkedSet, sourceLinkedSet, errorNodeId, errorMessage, values, components, selOutputsMap, hidden, toggleVisible, editSketch, isExposed, toggleExpose, setAlias, hoverPort, clearHoverPort],
  );

  const outType = NODE_SPECS[nodes.find((n) => n.id === outputId)?.data.nodeType ?? ""]?.output;
  const searchHits = search.trim()
    ? Object.values(NODE_SPECS).filter((s) => s.label.toLowerCase().includes(search.trim().toLowerCase()))
    : [];

  const openQuickAdd = (e: React.MouseEvent) => {
    const t = e.target as HTMLElement;
    // ignore double-clicks that land on a node, control, or minimap
    if (t.closest(".react-flow__node") || t.closest(".react-flow__controls") || t.closest(".react-flow__minimap"))
      return;
    if (!rf.current) return;
    const flow = rf.current.screenToFlowPosition({ x: e.clientX, y: e.clientY });
    setQuick({ sx: e.clientX, sy: e.clientY, flow, q: "" });
  };

  // remember the port a connection drag started from…
  const onConnectStart = useCallback((_: unknown, p: { nodeId: string | null; handleId: string | null; handleType: "source" | "target" | null }) => {
    connectStart.current = p.nodeId && p.handleType ? { nodeId: p.nodeId, handleId: p.handleId ?? (p.handleType === "source" ? "out" : ""), handleType: p.handleType } : null;
  }, []);

  // …and if it's released on empty canvas, offer the compatible nodes.
  const onConnectEnd = useCallback((e: MouseEvent | TouchEvent) => {
    const start = connectStart.current;
    connectStart.current = null;
    if (!start || !rf.current) return;
    const target = e.target as HTMLElement | null;
    if (!target || !target.classList.contains("react-flow__pane")) return; // landed on a handle → normal connect
    const node = nodes.find((n) => n.id === start.nodeId);
    if (!node) return;
    const socketType = start.handleType === "source" ? nodeOutType(node, start.handleId) : nodeInType(node, start.handleId);
    if (!socketType) return;
    const pt = "clientX" in e ? e : e.changedTouches[0];
    const flow = rf.current.screenToFlowPosition({ x: pt.clientX, y: pt.clientY });
    setQuick({ sx: pt.clientX, sy: pt.clientY, flow, q: "", connect: { ...start, socketType } });
  }, [nodes, nodeOutType, nodeInType]);

  /** Which input port of `spec` accepts a wire of type `t` (structural or param)? */
  const inputPortFor = (spec: (typeof NODE_SPECS)[string], t: SocketType): string | undefined =>
    spec.inputs.find((p) => p.type === t || (t === "solid" && p.type === "mesh"))?.name ??
    spec.params.map((p) => [p.name, paramPortType(p)] as const).find(([, pt]) => pt === t)?.[0];

  const quickHits = quick
    ? Object.values(NODE_SPECS)
        .filter((s) => {
          if (quick.q && !s.label.toLowerCase().includes(quick.q.toLowerCase())) return false;
          const c = quick.connect;
          if (!c) return true;
          return c.handleType === "source"
            ? !!inputPortFor(s, c.socketType) // node that can CONSUME the dragged output
            : s.output === c.socketType || (s.output === "solid" && c.socketType === "mesh"); // node that PRODUCES the needed input
        })
    : [];
  const addFromQuick = (type: string) => {
    if (!quick) return;
    const c = quick.connect;
    if (c) {
      const id = newId(type);
      const params: Record<string, unknown> = {};
      for (const p of NODE_SPECS[type].params) params[p.name] = p.default;
      if (type === "sketch") { const doc = starterRect(); params.doc = doc; for (const dim of dimensions(doc)) params[dim.name] = dim.value; }
      setNodes((prev) => [...prev.map((n) => ({ ...n, selected: false })), { id, type: "geo", position: quick.flow, selected: true, data: { nodeType: type, params } }]);
      const wire = c.handleType === "source"
        ? { source: c.nodeId, sourceHandle: c.handleId, target: id, targetHandle: inputPortFor(NODE_SPECS[type], c.socketType)! }
        : { source: id, sourceHandle: "out", target: c.nodeId, targetHandle: c.handleId };
      setEdges((es) => addEdge({ ...wire, style: { stroke: SOCKET_COLORS[c.socketType] } }, es));
    } else {
      addNode(type, { position: quick.flow, autoConnect: true });
    }
    setQuick(null);
  };

  return (
    <div className="editor">
      <div className="palette">
        <div className="palette__top">
          <input
            className="palette__search"
            placeholder="search nodes…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="palette__actions">
            <button onClick={undo} disabled={histLen.undo === 0} title="Undo (⌘Z)">↶</button>
            <button onClick={redo} disabled={histLen.redo === 0} title="Redo (⇧⌘Z)">↷</button>
            <button onClick={() => onFit?.()} title="Fit view">⊹</button>
            <button onClick={() => onTopView?.()} title="Top view (2D)">▣</button>
            <button onClick={collapseSelection} title="Group selection into a component">⧉</button>
            <button onClick={addNote} title="Add a comment note">📝</button>
            <button
              onClick={() => (outType === "sketch2d" ? onExportSVG : onExportSTL)?.(toGraph(nodes, edges), outputId)}
              title={outType === "sketch2d" ? "Export SVG" : "Export STL"}
            >
              ⬇{outType === "sketch2d" ? "SVG" : "STL"}
            </button>
            {outType === "sketch2d" && (
              <button onClick={() => onExportDXF?.(toGraph(nodes, edges), outputId)} title="Export DXF (laser)">⬇DXF</button>
            )}
            {outType !== "sketch2d" && (
              <button onClick={() => onExport3MF?.()} title="Export 3MF (3D print)">⬇3MF</button>
            )}
            {outType === "solid" && (
              <button onClick={() => onExportSTEP?.(toGraph(nodes, edges), outputId)} title="Export STEP">⬇STEP</button>
            )}
            <button onClick={() => onExportPNG?.()} title="Export a PNG render">⬇PNG</button>
            <button onClick={saveGraph} title="Save graph">💾</button>
            <label className="palette__loadbtn" title="Load graph">
              📂<input type="file" accept=".json,application/json" hidden onChange={loadGraph} />
            </label>
            <button
              title="Reset to the starter graph (clears the auto-saved work)"
              onClick={() => {
                if (!confirm("Reset the graph? Your auto-saved work will be cleared.")) return;
                try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
                setNodes(initialNodes);
                setEdges(initialEdges);
                setOutputId(initialOutputId);
              }}
            >
              ♻︎
            </button>
          </div>
          <select
            className="palette__examples"
            value=""
            onChange={(e) => {
              const ex = EXAMPLES.find((x) => x.name === e.target.value);
              if (ex) applyDoc(ex.doc);
            }}
            title="Load an example project"
          >
            <option value="" disabled>
              📚 Examples…
            </option>
            {EXAMPLES.map((ex) => (
              <option key={ex.name} value={ex.name}>
                {ex.title}
              </option>
            ))}
          </select>

          {/* user parameters: named values / expressions usable in any number
              field as `name` (e.g. width/2 + thickness) */}
          <div className="uparams">
            <div className="uparams__hd">
              <span>ƒ Parameters</span>
              <button
                className="uparams__add"
                title="Add a parameter"
                onClick={() => setUserParams((p) => [...p, { id: newId("up"), name: `p${p.length + 1}`, expr: "10" }])}
              >
                +
              </button>
            </div>
            {userParams.map((up) => {
              const bad = !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(up.name) || !(up.name in userVars);
              return (
                <div className={`uparams__row${bad ? " uparams__row--bad" : ""}`} key={up.id}>
                  <input
                    className="uparams__name" value={up.name} spellCheck={false} title="name"
                    onChange={(e) => setUserParams((p) => p.map((x) => (x.id === up.id ? { ...x, name: e.target.value } : x)))}
                  />
                  <input
                    className="uparams__expr" value={up.expr} spellCheck={false} title="value or expression"
                    onChange={(e) => setUserParams((p) => p.map((x) => (x.id === up.id ? { ...x, expr: e.target.value } : x)))}
                  />
                  <span className="uparams__val" title="resolved value">{up.name in userVars ? round4(userVars[up.name]) : "—"}</span>
                  <button className="uparams__del" title="remove" onClick={() => setUserParams((p) => p.filter((x) => x.id !== up.id))}>×</button>
                </div>
              );
            })}
            {userParams.length > 0 && (
              <div className="uparams__hint">Use these names in any number field, e.g. <code>width/2</code>.</div>
            )}
          </div>
        </div>

        {/* colour legend: each node's dot is its OUTPUT type — match it to an
            input port of the same colour to know what can feed it. */}
        <div className="palette__legend" title="La pastille d'un nœud = son type de sortie (forme + couleur). Branche-la sur une entrée de même forme.">
          {(Object.keys(SOCKET_COLORS) as (keyof typeof SOCKET_COLORS)[]).map((t) => (
            <span key={t} className="palette__leg">
              <span className={`palette__sw sock-${t}`} style={{ background: SOCKET_COLORS[t] }} />
              {SOCKET_LABELS[t].name}
            </span>
          ))}
        </div>

        <div className="palette__list">
          {search.trim() ? (
            searchHits.map((s) => (
              <button
                key={s.type}
                className="palette__node"
                onClick={() => addNode(s.type)}
                onMouseEnter={(e) => setTip({ type: s.type, y: e.currentTarget.getBoundingClientRect().top })}
                onMouseLeave={() => setTip(null)}
              >
                <span className={`palette__sw sock-${s.output}`} style={{ background: SOCKET_COLORS[s.output] }} title={`sortie : ${SOCKET_LABELS[s.output].name}`} />
                <span className="palette__ic">{nodeIcon(s.type, false)}</span>
                {s.label}
              </button>
            ))
          ) : (
            NODE_CATEGORIES.map((cat) => {
              const open = !collapsed.has(cat.name);
              return (
                <div key={cat.name} className="palcat">
                  <button
                    className="palcat__hd"
                    onClick={() =>
                      setCollapsed((prev) => {
                        const n = new Set(prev);
                        n.has(cat.name) ? n.delete(cat.name) : n.add(cat.name);
                        return n;
                      })
                    }
                  >
                    {open ? "▾" : "▸"} {cat.name}
                  </button>
                  {open &&
                    cat.types.map((t) => (
                      <button
                        key={t}
                        className="palette__node"
                        onClick={() => addNode(t)}
                        onMouseEnter={(e) => setTip({ type: t, y: e.currentTarget.getBoundingClientRect().top })}
                        onMouseLeave={() => setTip(null)}
                      >
                        <span className={`palette__sw sock-${NODE_SPECS[t].output}`} style={{ background: SOCKET_COLORS[NODE_SPECS[t].output] }} title={`sortie : ${SOCKET_LABELS[NODE_SPECS[t].output].name}`} />
                        <span className="palette__ic">{nodeIcon(t, false)}</span>
                        {NODE_SPECS[t].label}
                      </button>
                    ))}
                </div>
              );
            })
          )}
        </div>
        <span className="palette__hint">double-click canvas to add · click a node to view · ⌫ deletes</span>
      </div>

      {/* hover tooltip: what the node does + a preview image */}
      {tip && (NODE_DESCRIPTIONS[tip.type] || NODE_THUMBS[tip.type]) && (
        <div className="nodetip" style={{ top: Math.max(8, Math.min(tip.y, window.innerHeight - 220)) }}>
          <div className="nodetip__title">{NODE_SPECS[tip.type]?.label ?? tip.type}</div>
          {NODE_THUMBS[tip.type] && (
            <div className="nodetip__img" dangerouslySetInnerHTML={{ __html: NODE_THUMBS[tip.type] }} />
          )}
          <div className="nodetip__desc">{NODE_DESCRIPTIONS[tip.type]}</div>
        </div>
      )}

      {/* port hover tooltip: what the socket colour means */}
      {portTip && (
        <div
          className="porttip"
          style={{
            left: Math.min(portTip.x + 14, window.innerWidth - 220),
            top: Math.min(portTip.y + 14, window.innerHeight - 70),
          }}
        >
          <span className="porttip__sw" style={{ background: SOCKET_COLORS[portTip.type] }} />
          <span className="porttip__name">{SOCKET_LABELS[portTip.type].name}</span>
          <span className="porttip__desc">{SOCKET_LABELS[portTip.type].desc}</span>
        </div>
      )}

      <div className="editor__canvas" onDoubleClick={openQuickAdd}>
        <Ctx.Provider value={ctx}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onInit={(inst) => (rf.current = inst)}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onConnectStart={onConnectStart}
            onConnectEnd={onConnectEnd}
            isValidConnection={isValidConnection}
            nodeTypes={nodeTypes}
            deleteKeyCode={editingSketchId ? null : ["Backspace", "Delete"]}
            zoomOnDoubleClick={false}
            fitView
            proOptions={{ hideAttribution: true }}
          >
            <Background color="#2a2e36" gap={18} />
            <Controls position="top-left" />
            <MiniMap pannable zoomable className="editor__minimap" position="top-right" />
          </ReactFlow>
        </Ctx.Provider>

        {quick && (
          <>
            <div className="quick__scrim" onClick={() => setQuick(null)} />
            <div className="quick" style={{ left: Math.min(quick.sx, window.innerWidth - 240), top: Math.min(quick.sy, window.innerHeight - 320) }}>
              {quick.connect && (
                <div className="quick__ctx">
                  <span className="quick__sw" style={{ background: SOCKET_COLORS[quick.connect.socketType] }} />
                  {quick.connect.handleType === "source" ? "→ nœuds acceptant " : "← nœuds produisant "}
                  <b>{SOCKET_LABELS[quick.connect.socketType].name}</b>
                </div>
              )}
              <input
                className="quick__search"
                autoFocus
                placeholder={quick.connect ? "filtrer…" : "add node…"}
                value={quick.q}
                onChange={(e) => setQuick({ ...quick, q: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && quickHits[0]) addFromQuick(quickHits[0].type);
                  if (e.key === "Escape") setQuick(null);
                }}
              />
              <div className="quick__list">
                {quickHits.map((s) => (
                  <button key={s.type} className="quick__item" onClick={() => addFromQuick(s.type)}>
                    <span className="quick__ic">{nodeIcon(s.type, false)}</span>
                    <span className="quick__sw" style={{ background: SOCKET_COLORS[s.output] }} />
                    {s.label}
                  </button>
                ))}
                {quickHits.length === 0 && <div className="quick__empty">aucun nœud compatible</div>}
              </div>
            </div>
          </>
        )}

        {/* history timeline (Fusion-style), in GENERATION order. By default only
            construction steps (geometry) show; the ⚙ toggle reveals helper nodes
            (selections, values, math) that merely parametrise them. */}
        <div className="timeline" title="Generation order — click a step to view it">
          <button
            className={`tl__filter${showHelpers ? " tl__filter--on" : ""}`}
            title={showHelpers ? "Hide helper nodes (selections, values)" : "Show helper nodes (selections, values)"}
            onClick={() => setShowHelpers((v) => !v)}
          >
            ⚙
          </button>
          {timelineOrder
            .filter((n) => showHelpers || isConstructionNode(n, components))
            .map((n) => {
              const active = n.id === outputId;
              const isComp = !!n.data.component;
              const label = isComp
                ? (components[n.data.component!]?.name ?? "Component")
                : (NODE_SPECS[n.data.nodeType]?.label ?? n.data.nodeType);
              return (
                <button
                  key={n.id}
                  className={`tl__item${active ? " tl__item--active" : ""}`}
                  title={label}
                  onClick={() => {
                    setOutputId(n.id);
                    setNodes((ns) => ns.map((x) => ({ ...x, selected: x.id === n.id })));
                    rf.current?.fitView({ nodes: [{ id: n.id }], duration: 300, maxZoom: 1.2 });
                  }}
                >
                  <span className="tl__icon">{nodeIcon(n.data.nodeType, isComp)}</span>
                </button>
              );
            })}
        </div>
      </div>

      {/* Simple / Expert view switch — a floating pill, always visible */}
      <div className="modetabs">
        <button className={mode === "simple" ? "on" : ""} onClick={() => setMode("simple")} title="Formulaire de paramètres (sans nœuds)">◧ Simple</button>
        <button className={mode === "expert" ? "on" : ""} onClick={() => setMode("expert")} title="Éditeur de nœuds complet">⚙ Expert</button>
      </div>

      {/* Simple mode overlays the node editor with a clean parameter form; the
          node graph keeps running underneath so the 3D view stays live. */}
      {mode === "simple" && (
        <SimpleView
          nodes={nodes}
          components={components}
          exposed={exposed}
          userParams={userParams}
          userVars={userVars}
          setParam={setParam}
          setUserParams={setUserParams}
          setExposed={setExposed}
          applyDoc={applyDoc}
        />
      )}

      {/* full-screen 2D constraint sketch editor */}
      {editingSketchId && (() => {
        const node = nodes.find((n) => n.id === editingSketchId);
        const doc = node?.data.params.doc as SketchDoc | undefined;
        if (!node || !doc) { setEditingSketchId(null); return null; }
        // open with dimension values synced from the node params (the user may
        // have tweaked a dimension via the node field since the last edit)
        const synced: SketchDoc = { ...doc, constraints: doc.constraints.map((c) => (isDim(c) && node.data.params[c.name] != null ? { ...c, value: Number(node.data.params[c.name]) } : c)) };
        return (
          <SketchEditor
            initialDoc={synced}
            onCommit={(d: SketchDoc) => { commitSketch(editingSketchId, d); setEditingSketchId(null); }}
            onCancel={() => setEditingSketchId(null)}
          />
        );
      })()}
    </div>
  );
}
