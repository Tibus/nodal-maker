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
  Handle,
  Position,
  addEdge,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  type Connection,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  NODE_SPECS,
  SOCKET_COLORS,
  paramPortType,
  type Graph,
  type NodeDescriptor,
  type ParamSpec,
  type SocketType,
} from "./kernel/client";

type GeoData = {
  nodeType: string;
  params: Record<string, unknown>;
};
type GeoNode = Node<GeoData>;

interface EditorCtx {
  outputId: string;
  setOutput: (id: string) => void;
  setParam: (id: string, name: string, value: unknown) => void;
  isLinked: (nodeId: string, port: string) => boolean;
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

/**
 * Can this source output feed that target input? Same type, or the one implicit
 * coercion we support: a B-rep solid into a mesh port (auto-tessellated).
 */
function isCompatible(srcType: string, tgtType: string, tgtHandle: string): boolean {
  const out = NODE_SPECS[srcType]?.output;
  const inp = handleType(tgtType, tgtHandle);
  if (!out || !inp) return false;
  return out === inp || (out === "solid" && inp === "mesh");
}

/* ------------------------------------------------------------------ */
/* Custom node                                                         */
/* ------------------------------------------------------------------ */

function GeoNodeView({ id, data }: NodeProps<GeoNode>) {
  const ctx = useContext(Ctx)!;
  const spec = NODE_SPECS[data.nodeType];
  const isOutput = ctx.outputId === id;

  return (
    <div className={`gnode${isOutput ? " gnode--out" : ""}`} onClick={() => ctx.setOutput(id)}>
      <div className="gnode__title">
        {spec.label}
        {isOutput && <span className="gnode__badge">● view</span>}
      </div>

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
      </div>

      <Handle
        id="out"
        type="source"
        position={Position.Right}
        className="rf-port rf-port--req"
        style={{ background: SOCKET_COLORS[spec.output] }}
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
}

let uid = 0;
const newId = (t: string) => `${t}_${++uid}`;

/** Build a serialisable Graph from React Flow nodes + edges. */
function toGraph(nodes: GeoNode[], edges: Edge[]): Graph {
  return nodes.map<NodeDescriptor>((n) => {
    const inputs: Record<string, string> = {};
    for (const e of edges) {
      if (e.target === n.id && e.targetHandle) inputs[e.targetHandle] = e.source;
    }
    return { id: n.id, type: n.data.nodeType, params: n.data.params, inputs };
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

export default function NodeEditor({
  initialNodes,
  initialEdges,
  initialOutputId,
  onChange,
  onReady,
}: NodeEditorProps) {
  const [nodes, setNodes, onNodesChange] = useNodesState<GeoNode>(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(initialEdges);
  const [outputId, setOutputId] = useState(initialOutputId);

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
    const graph = toGraph(nodes, edges);
    const sig = graphSignature(graph, validOut);
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
      onChange(graph, validOut);
    }
    prevSnap.current = { nodes, edges, outputId: validOut };
  }, [nodes, edges, outputId, onChange]);

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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return; // let fields keep their own undo
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo]);

  const isValidConnection = useCallback(
    (c: Connection | Edge) => {
      if (!c.source || !c.target || !c.targetHandle || c.source === c.target) return false;
      const src = nodes.find((n) => n.id === c.source);
      const tgt = nodes.find((n) => n.id === c.target);
      return !!src && !!tgt && isCompatible(src.data.nodeType, tgt.data.nodeType, c.targetHandle);
    },
    [nodes],
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
      const outType = NODE_SPECS[src.data.nodeType].output;
      const inType = handleType(tgt.data.nodeType, c.targetHandle);
      if (!inType) return;

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
    [nodes, edges, setEdges, setNodes],
  );

  const addNode = useCallback(
    (type: string) => {
      const spec = NODE_SPECS[type];
      const params: Record<string, unknown> = {};
      for (const p of spec.params) params[p.name] = p.default;
      setNodes((prev) => [
        ...prev,
        {
          id: newId(type),
          type: "geo",
          position: { x: 40 + Math.random() * 80, y: 40 + Math.random() * 220 },
          data: { nodeType: type, params },
        },
      ]);
    },
    [setNodes],
  );

  const saveGraph = useCallback(() => {
    const payload = {
      version: 1,
      outputId,
      nodes: nodes.map((n) => ({
        id: n.id,
        position: n.position,
        data: {
          nodeType: n.data.nodeType,
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
    a.download = "graph.json";
    a.click();
    URL.revokeObjectURL(url);
  }, [nodes, edges, outputId]);

  const loadGraph = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const f = e.target.files?.[0];
      if (!f) return;
      const doc = JSON.parse(await f.text());
      const loadedNodes: GeoNode[] = doc.nodes.map((n: { id: string; position: { x: number; y: number }; data: { nodeType: string; params: Record<string, unknown> } }) => ({
        id: n.id,
        type: "geo",
        position: n.position,
        data: {
          nodeType: n.data.nodeType,
          params: Object.fromEntries(
            Object.entries(n.data.params).map(([k, v]) => [
              k,
              v && typeof v === "object" && "__ab" in v ? b642ab((v as { __ab: string }).__ab) : v,
            ]),
          ),
        },
      }));
      lastSig.current = ""; // force re-emit
      setNodes(loadedNodes);
      setEdges(doc.edges as Edge[]);
      setOutputId(doc.outputId);
    },
    [setNodes, setEdges],
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
    }),
    [outputId, setOutput, setParam, linkedSet],
  );

  return (
    <div className="editor">
      <div className="palette">
        {Object.values(NODE_SPECS).map((s) => (
          <button key={s.type} className="palette__btn" onClick={() => addNode(s.type)}>
            + {s.label}
          </button>
        ))}
        <button className="palette__btn" onClick={undo} disabled={histLen.undo === 0} title="⌘Z">↶ Undo</button>
        <button className="palette__btn" onClick={redo} disabled={histLen.redo === 0} title="⇧⌘Z">↷ Redo</button>
        <button className="palette__btn" onClick={saveGraph}>💾 Save</button>
        <label className="palette__btn">
          📂 Load
          <input type="file" accept=".json,application/json" hidden onChange={loadGraph} />
        </label>
        <span className="palette__hint">click a node to display it · ⌫ deletes · ⌘Z undo</span>
      </div>
      <Ctx.Provider value={ctx}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          isValidConnection={isValidConnection}
          nodeTypes={nodeTypes}
          deleteKeyCode={["Backspace", "Delete"]}
          fitView
          proOptions={{ hideAttribution: true }}
        >
          <Background color="#2a2e36" gap={18} />
          <Controls />
        </ReactFlow>
      </Ctx.Provider>
    </div>
  );
}
