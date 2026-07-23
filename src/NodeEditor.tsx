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
  SOCKET_COLORS,
  paramPortType,
  expandDescriptors,
  expandOutputId,
  type Graph,
  type ParamSpec,
  type SocketType,
  type ComponentDef,
  type InstanceDescriptor,
} from "./kernel/client";

type GeoData = {
  nodeType: string;
  params: Record<string, unknown>;
  /** set when this node is a component instance (points at a ComponentDef id) */
  component?: string;
};
type GeoNode = Node<GeoData>;

interface EditorCtx {
  outputId: string;
  setOutput: (id: string) => void;
  setParam: (id: string, name: string, value: unknown) => void;
  isLinked: (nodeId: string, port: string) => boolean;
  errorNodeId: string | null;
  errorMessage: string | null;
  valueOf: (nodeId: string) => string | undefined;
  componentDef: (defId: string) => ComponentDef | undefined;
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
        {spec.label}
        {isOutput && <span className="gnode__badge">● view</span>}
      </div>
      {value !== undefined && <div className="gnode__value">= {value}</div>}
      {isError && <div className="gnode__err">⚠ {ctx.errorMessage}</div>}

      <div className="gnode__body" onClick={(e) => e.stopPropagation()}>
        {/* structural inputs — required, filled ports */}
        {spec.inputs.map((p) => (
          <div className="gnode__row" key={`in-${p.name}`}>
            <Handle
              id={p.name}
              type="target"
              position={Position.Left}
              className="rf-port rf-port--req"
              style={{ background: SOCKET_COLORS[p.type] }}
              title={`${p.name}: ${p.type} (required)`}
            />
            <span className="gnode__portlabel" style={{ color: SOCKET_COLORS[p.type] }}>
              {p.name}
            </span>
          </div>
        ))}

        {/* params — those that are portable get an OPTIONAL, hollow port */}
        {spec.params.map((ps) => {
          const pt = paramPortType(ps);
          const linked = pt !== null && ctx.isLinked(id, ps.name);
          return (
            <div className={`gnode__row${pt ? " gnode__row--param" : ""}`} key={`p-${ps.name}`}>
              {pt && (
                <Handle
                  id={ps.name}
                  type="target"
                  position={Position.Left}
                  className="rf-port rf-port--opt"
                  style={{ borderColor: SOCKET_COLORS[pt] }}
                  title={`${ps.name}: ${pt} (optional — has a default)`}
                />
              )}
              {linked ? (
                <div className="pf pf--linked">
                  <span>{ps.label ?? ps.name}</span>
                  <em style={{ color: SOCKET_COLORS[pt!] }}>◀ linked</em>
                </div>
              ) : (
                <ParamField
                  spec={ps}
                  value={data.params[ps.name]}
                  onChange={(v) => ctx.setParam(id, ps.name, v)}
                />
              )}
            </div>
          );
        })}

        {/* exposed selection outputs (cap / sides / edges…) on the right */}
        {spec.selectionOutputs?.map((so) => {
          const t: SocketType = "selection";
          return (
            <div className="gnode__row gnode__row--out" key={`so-${so.name}`}>
              <span className="gnode__portlabel gnode__portlabel--r" style={{ color: SOCKET_COLORS[t] }}>
                {so.name} ▶
              </span>
              <Handle
                id={so.name}
                type="source"
                position={Position.Right}
                className="rf-port rf-port--req"
                style={{ background: SOCKET_COLORS[t] }}
                title={`${so.name}: ${so.target} selection`}
              />
            </div>
          );
        })}
      </div>

      <Handle
        id="out"
        type="source"
        position={Position.Right}
        className="rf-port rf-port--req"
        style={{ background: SOCKET_COLORS[spec.output], top: 22 }}
        title={`out: ${spec.output}`}
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
    return (
      <label className="pf">
        <span>{label}</span>
        <input
          type="number"
          value={Number(value ?? 0)}
          min={spec.min}
          max={spec.max}
          step={spec.step}
          onChange={(e) => onChange(Number(e.target.value))}
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
  if (spec.kind === "stl") {
    const loaded = value instanceof ArrayBuffer;
    return (
      <label className="pf pf--file">
        <span>{label}</span>
        <span className="pf__filebtn">
          {loaded ? "✓ loaded" : "choose .stl"}
          <input
            type="file"
            accept=".stl,model/stl"
            hidden
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (f) onChange(await f.arrayBuffer());
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

const nodeTypes = { geo: GeoNodeView };

export interface EditorApi {
  /** imperatively set a node param (used by the 3D gizmo to write tx/ty/tz) */
  setParam: (nodeId: string, name: string, value: unknown) => void;
}

export interface NodeEditorProps {
  initialNodes: GeoNode[];
  initialEdges: Edge[];
  initialOutputId: string;
  onChange: (graph: Graph, outputId: string) => void;
  /** hands the parent an imperative handle once mounted */
  onReady?: (api: EditorApi) => void;
  errorNodeId?: string | null;
  errorMessage?: string | null;
  values?: Record<string, string>;
  onExportSTL?: (graph: Graph, outputId: string) => void;
  onExportSVG?: (graph: Graph, outputId: string) => void;
  onExportDXF?: (graph: Graph, outputId: string) => void;
  onExportSTEP?: (graph: Graph, outputId: string) => void;
  onFit?: () => void;
  onTopView?: () => void;
  onExportPNG?: () => void;
}

let uid = 0;
const newId = (t: string) => `${t}_${++uid}`;

/** Build serialisable instance descriptors from React Flow nodes + edges. */
function toGraph(nodes: GeoNode[], edges: Edge[]): InstanceDescriptor[] {
  return nodes.map<InstanceDescriptor>((n) => {
    const inputs: Record<string, string> = {};
    for (const e of edges) {
      if (e.target === n.id && e.targetHandle) {
        // encode a non-default source handle (selection output) as "src#handle"
        inputs[e.targetHandle] = e.sourceHandle && e.sourceHandle !== "out" ? `${e.source}#${e.sourceHandle}` : e.source;
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
  nodes: {
    id: string;
    position: { x: number; y: number };
    data: { nodeType: string; component?: string; params: Record<string, unknown> };
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

export default function NodeEditor({
  initialNodes,
  initialEdges,
  initialOutputId,
  onChange,
  onReady,
  errorNodeId,
  errorMessage,
  values,
  onExportSTL,
  onExportSVG,
  onExportDXF,
  onExportSTEP,
  onFit,
  onTopView,
  onExportPNG,
}: NodeEditorProps) {
  const [nodes, setNodes, onNodesChange] = useNodesState<GeoNode>(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(initialEdges);
  const [outputId, setOutputId] = useState(initialOutputId);

  const rf = useRef<ReactFlowInstance<GeoNode, Edge> | null>(null);
  const [search, setSearch] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [quick, setQuick] = useState<{ sx: number; sy: number; flow: { x: number; y: number }; q: string } | null>(null);
  const [components, setComponents] = useState<Record<string, ComponentDef>>({});

  // socket type of a node's output handle (main "out" or a selection output)
  const nodeOutType = useCallback(
    (n: GeoNode, handle: string = "out"): SocketType | undefined => {
      if (handle !== "out") {
        const so = NODE_SPECS[n.data.nodeType]?.selectionOutputs?.find((o) => o.name === handle);
        return so ? "selection" : undefined;
      }
      return n.data.component ? components[n.data.component]?.outputType : NODE_SPECS[n.data.nodeType]?.output;
    },
    [components],
  );
  const nodeInType = useCallback(
    (n: GeoNode, handle: string): SocketType | undefined => {
      if (n.data.component) return components[n.data.component]?.inputs.find((i) => i.name === handle)?.type;
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
    const validOut = nodes.some((n) => n.id === outputId)
      ? outputId
      : (nodes[nodes.length - 1]?.id ?? "");
    if (validOut !== outputId) {
      setOutputId(validOut); // output node was deleted → fall back, re-runs effect
      return;
    }
    const descs = toGraph(nodes, edges);
    // expand component instances into a flat graph for the evaluator
    const flat = expandDescriptors(descs, components);
    const flatOut = expandOutputId(validOut, descs, components);
    const sig = graphSignature(flat, flatOut);
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
      onChange(flat, flatOut);
    }
    prevSnap.current = { nodes, edges, outputId: validOut };
  }, [nodes, edges, outputId, onChange, components]);

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
  }, [undo, redo, copySelection, pasteClipboard, duplicateSelection]);

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

  useEffect(() => {
    onReady?.({ setParam });
  }, [onReady, setParam]);

  const onConnect = useCallback(
    (c: Connection) => {
      const src = nodes.find((n) => n.id === c.source);
      const tgt = nodes.find((n) => n.id === c.target);
      if (!src || !tgt || !c.targetHandle) return;
      const outType = nodeOutType(src, c.sourceHandle ?? "out");
      const inType = nodeInType(tgt, c.targetHandle);
      if (!outType || !inType) return;

      // one input port takes at most one wire — drop any existing edge into it
      const freed = edges.filter((e) => !(e.target === tgt.id && e.targetHandle === c.targetHandle));

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
        position: n.position,
        data: {
          nodeType: n.data.nodeType,
          component: n.data.component,
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
        type: "geo",
        position: n.position,
        data: {
          nodeType: n.data.nodeType,
          component: n.data.component,
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

  // which (node, port) targets currently have an incoming wire
  const linkedSet = useMemo(() => {
    const s = new Set<string>();
    for (const e of edges) if (e.targetHandle) s.add(`${e.target} ${e.targetHandle}`);
    return s;
  }, [edges]);

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
    }),
    [outputId, setOutput, setParam, linkedSet, errorNodeId, errorMessage, values, components],
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
  const quickHits = quick
    ? Object.values(NODE_SPECS)
        .filter((s) => s.label.toLowerCase().includes(quick.q.toLowerCase()))
        .slice(0, 8)
    : [];
  const addFromQuick = (type: string) => {
    if (!quick) return;
    addNode(type, { position: quick.flow, autoConnect: true });
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
            <button
              onClick={() => (outType === "sketch2d" ? onExportSVG : onExportSTL)?.(toGraph(nodes, edges), outputId)}
              title={outType === "sketch2d" ? "Export SVG" : "Export STL"}
            >
              ⬇{outType === "sketch2d" ? "SVG" : "STL"}
            </button>
            {outType === "sketch2d" && (
              <button onClick={() => onExportDXF?.(toGraph(nodes, edges), outputId)} title="Export DXF (laser)">⬇DXF</button>
            )}
            {outType === "solid" && (
              <button onClick={() => onExportSTEP?.(toGraph(nodes, edges), outputId)} title="Export STEP">⬇STEP</button>
            )}
            <button onClick={() => onExportPNG?.()} title="Export a PNG render">⬇PNG</button>
            <button onClick={saveGraph} title="Save graph">💾</button>
            <label className="palette__loadbtn" title="Load graph">
              📂<input type="file" accept=".json,application/json" hidden onChange={loadGraph} />
            </label>
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
        </div>

        <div className="palette__list">
          {search.trim() ? (
            searchHits.map((s) => (
              <button key={s.type} className="palette__node" onClick={() => addNode(s.type)}>
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
                      <button key={t} className="palette__node" onClick={() => addNode(t)}>
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

      <div className="editor__canvas" onDoubleClick={openQuickAdd}>
        <Ctx.Provider value={ctx}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onInit={(inst) => (rf.current = inst)}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            isValidConnection={isValidConnection}
            nodeTypes={nodeTypes}
            deleteKeyCode={["Backspace", "Delete"]}
            zoomOnDoubleClick={false}
            fitView
            proOptions={{ hideAttribution: true }}
          >
            <Background color="#2a2e36" gap={18} />
            <Controls />
            <MiniMap pannable zoomable className="editor__minimap" />
          </ReactFlow>
        </Ctx.Provider>

        {quick && (
          <>
            <div className="quick__scrim" onClick={() => setQuick(null)} />
            <div className="quick" style={{ left: quick.sx, top: quick.sy }}>
              <input
                className="quick__search"
                autoFocus
                placeholder="add node…"
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
                    {s.label}
                  </button>
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
