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
  type Graph,
  type NodeDescriptor,
  type ParamSpec,
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
}
const Ctx = createContext<EditorCtx | null>(null);

/* ------------------------------------------------------------------ */
/* Custom node                                                         */
/* ------------------------------------------------------------------ */

function GeoNodeView({ id, data }: NodeProps<GeoNode>) {
  const ctx = useContext(Ctx)!;
  const spec = NODE_SPECS[data.nodeType];
  const isOutput = ctx.outputId === id;

  return (
    <div className={`gnode${isOutput ? " gnode--out" : ""}`} onClick={() => ctx.setOutput(id)}>
      {spec.inputs.map((p, i) => (
        <Handle
          key={p.name}
          id={p.name}
          type="target"
          position={Position.Left}
          style={{ top: 34 + i * 20, background: SOCKET_COLORS[p.type] }}
          title={`${p.name}: ${p.type}`}
        />
      ))}

      <div className="gnode__title">
        {spec.label}
        {isOutput && <span className="gnode__badge">● view</span>}
      </div>

      <div className="gnode__body" onClick={(e) => e.stopPropagation()}>
        {spec.params.map((ps) => (
          <ParamField
            key={ps.name}
            spec={ps}
            value={data.params[ps.name]}
            onChange={(v) => ctx.setParam(id, ps.name, v)}
          />
        ))}
        {spec.inputs.map((p) => (
          <div key={p.name} className="gnode__port" style={{ color: SOCKET_COLORS[p.type] }}>
            ◀ {p.name}
          </div>
        ))}
      </div>

      <Handle
        id="out"
        type="source"
        position={Position.Right}
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
  if (spec.kind === "stl" || spec.kind === "font") {
    const loaded = value instanceof ArrayBuffer;
    const accept = spec.kind === "stl" ? ".stl,model/stl" : ".ttf,.otf,font/ttf,font/otf";
    const hint = spec.kind === "stl" ? "choose .stl" : "choose .ttf";
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

/* ------------------------------------------------------------------ */
/* Editor                                                              */
/* ------------------------------------------------------------------ */

const nodeTypes = { geo: GeoNodeView };

export interface NodeEditorProps {
  initialNodes: GeoNode[];
  initialEdges: Edge[];
  initialOutputId: string;
  onChange: (graph: Graph, outputId: string) => void;
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
}: NodeEditorProps) {
  const [nodes, setNodes, onNodesChange] = useNodesState<GeoNode>(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(initialEdges);
  const [outputId, setOutputId] = useState(initialOutputId);

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
      lastSig.current = sig;
      onChange(graph, validOut);
    }
  }, [nodes, edges, outputId, onChange]);

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

  const onConnect = useCallback(
    (c: Connection) => {
      const src = nodes.find((n) => n.id === c.source);
      const tgt = nodes.find((n) => n.id === c.target);
      if (!src || !tgt || !c.targetHandle) return;
      const outType = NODE_SPECS[src.data.nodeType].output;
      const inType = NODE_SPECS[tgt.data.nodeType].inputs.find(
        (p) => p.name === c.targetHandle,
      )?.type;
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

  const ctx = useMemo<EditorCtx>(
    () => ({ outputId, setOutput, setParam }),
    [outputId, setOutput, setParam],
  );

  return (
    <div className="editor">
      <div className="palette">
        {Object.values(NODE_SPECS).map((s) => (
          <button key={s.type} className="palette__btn" onClick={() => addNode(s.type)}>
            + {s.label}
          </button>
        ))}
        <button className="palette__btn" onClick={saveGraph}>💾 Save</button>
        <label className="palette__btn">
          📂 Load
          <input type="file" accept=".json,application/json" hidden onChange={loadGraph} />
        </label>
        <span className="palette__hint">click a node to display it · ⌫ deletes selection</span>
      </div>
      <Ctx.Provider value={ctx}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
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
