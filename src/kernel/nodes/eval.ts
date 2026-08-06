/**
 * Graph evaluation engine — topological eval + incremental (content-addressed)
 * caching — and the assembled node REGISTRY.
 */
import type { EvalCache, Graph, GraphValue, NodeImpl } from "./types";
import { parseRef, resolveInputs, resolveRef } from "./selection";
import { valueNodes } from "./registry.value";
import { nodes2d } from "./registry.2d";
import { nodes3d } from "./registry.3d";
import { meshNodes } from "./registry.mesh";

/* ------------------------------------------------------------------ */
/* Node registry                                                       */
/* ------------------------------------------------------------------ */

export const REGISTRY: Record<string, NodeImpl> = {
  ...valueNodes,
  ...nodes2d,
  ...nodes3d,
  ...meshNodes,
};

/* ------------------------------------------------------------------ */
/* Graph evaluation (topological)                                      */
/* ------------------------------------------------------------------ */

/**
 * Rewrite a raw node failure into a clear, actionable message. Our own node
 * errors already read "[node] …" and pass through untouched; cryptic OCCT /
 * replicad kernel aborts get mapped to a plain-language hint prefixed by the
 * node type. Exported so the test suite can lock the mapping in.
 */
export function humanizeError(nodeType: string, raw: string): string {
  if (raw.trimStart().startsWith("[")) return raw; // already a friendly node message
  const n = nodeType.toLowerCase();
  const r = raw.toLowerCase();
  let hint: string;
  // the failing node's own type is the strongest signal — a generic OCCT abort
  // on a fillet almost always means the radius is too big, etc.
  if (/fillet|bevel|chamfer/.test(n) || /fillet|chamfer|chfi|blend/.test(r)) hint = "fillet/chamfer radius is too large for this edge — reduce it";
  else if (/shell|hollow|infill|thicken/.test(n) || /offset|\bshell\b|thick/.test(r)) hint = "wall thickness is invalid (too large, or the walls self-intersect)";
  else if (/bool|collision/.test(n) || /fuse|\bcut\b|common|intersect|boolean/.test(r)) hint = "boolean failed — the shapes may be disjoint, coplanar or non-manifold";
  else if (/loft|sweep|revolve|extrude/.test(n) || /loft|sweep|revolve|extrude/.test(r)) hint = "could not build the solid — check the profile is a single closed loop";
  else if (/null|empty|no geometry|no result|nothing to/.test(r)) hint = "produced no geometry — check the inputs are connected";
  else if (/notdone|not done|stdfail|standard_|brep_api|abort|failed/.test(r)) hint = "the kernel could not complete this operation on the given geometry";
  else hint = raw; // unknown — surface the raw message rather than hide it
  return `[${nodeType}] ${hint}`;
}

export function evalGraph(graph: Graph, vars: Record<string, number> = {}): { outputs: Record<string, GraphValue>; order: string[] } {
  const byId = new Map(graph.map((n) => [n.id, n]));
  const cache = new Map<string, GraphValue>();
  const visiting = new Set<string>();
  const order: string[] = [];

  const evalNode = (id: string): GraphValue => {
    const cached = cache.get(id);
    if (cached) return cached;
    if (visiting.has(id)) throw new Error(`cycle detected at node ${id}`);
    const node = byId.get(id);
    if (!node) throw new Error(`unknown node ${id}`);
    visiting.add(id);

    const rawInputs: Record<string, GraphValue> = {};
    for (const [port, ref] of Object.entries(node.inputs ?? {})) {
      rawInputs[port] = resolveRef(ref, byId, evalNode);
    }
    const impl = REGISTRY[node.type];
    if (!impl) throw new Error(`no implementation for node type "${node.type}"`);
    const { inputs, params } = resolveInputs(node.type, rawInputs, node.params ?? {}, vars);
    const out = impl(inputs, params);

    visiting.delete(id);
    cache.set(id, out);
    order.push(id);
    return out;
  };

  const outputs: Record<string, GraphValue> = {};
  for (const n of graph) outputs[n.id] = evalNode(n.id);
  return { outputs, order };
}

/* ------------------------------------------------------------------ */
/* Incremental (content-addressed) evaluation                          */
/*                                                                     */
/* A persistent cache keyed by a content hash of each node             */
/* (type + params + the hashes of its inputs). When a param changes,   */
/* only that node's hash — and its descendants' — change; every        */
/* untouched upstream node is served straight from cache. This is what */
/* makes live editing cheap: change the boss height and OCCT does NOT  */
/* re-extrude the base profile.                                        */
/* ------------------------------------------------------------------ */

export function makeEvalCache(): EvalCache {
  return { entries: new Map(), run: 0 };
}

function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16);
}

function hashParams(params: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const k of Object.keys(params).sort()) {
    const v = params[k];
    if (v instanceof ArrayBuffer) {
      const b = new Uint8Array(v);
      // cheap content signature — length + a few sampled bytes
      parts.push(`${k}:ab${b.byteLength}:${b[0] ?? 0}:${b[b.length >> 1] ?? 0}:${b[b.length - 1] ?? 0}`);
    } else {
      parts.push(`${k}:${JSON.stringify(v)}`);
    }
  }
  return parts.join("|");
}

/** Free the WASM object behind a cached B-rep value (mesh values are plain JS). */
function disposeValue(v: GraphValue): void {
  try {
    if (v.kind === "solid") (v.solid as unknown as { delete?: () => void }).delete?.();
    else if (v.kind === "sketch2d") (v.drawing as unknown as { delete?: () => void }).delete?.();
  } catch {
    /* best-effort — never let cleanup crash an eval */
  }
}

const CACHE_MAX_ENTRIES = 256;

export function evalGraphCached(
  graph: Graph,
  cache: EvalCache,
  vars: Record<string, number> = {},
): { outputs: Record<string, GraphValue>; hits: number; misses: number } {
  cache.run++;
  const byId = new Map(graph.map((n) => [n.id, n]));
  // user params affect any expression param, so fold them into every cache key
  const varsKey = Object.keys(vars).sort().map((k) => `${k}=${vars[k]}`).join(";");
  const keyMemo = new Map<string, string>();
  const valMemo = new Map<string, GraphValue>();
  const visiting = new Set<string>();
  let hits = 0;
  let misses = 0;

  const keyOf = (id: string): string => {
    const memo = keyMemo.get(id);
    if (memo) return memo;
    const node = byId.get(id);
    if (!node) throw new Error(`unknown node ${id}`);
    const childParts: string[] = [];
    for (const [port, ref] of Object.entries(node.inputs ?? {})) {
      const { node: srcId, handle } = parseRef(ref);
      childParts.push(`${port}=${keyOf(srcId)}#${handle}`);
    }
    const key = fnv1a(
      `${node.type}(${hashParams(node.params ?? {})})[${childParts.sort().join(",")}]{${varsKey}}`,
    );
    keyMemo.set(id, key);
    return key;
  };

  const evalNode = (id: string): GraphValue => {
    const done = valMemo.get(id);
    if (done) return done;
    if (visiting.has(id)) throw new Error(`cycle detected at node ${id}`);
    const node = byId.get(id)!;
    visiting.add(id);

    const key = keyOf(id);
    const hit = cache.entries.get(key);
    let value: GraphValue;
    if (hit) {
      hit.run = cache.run; // refresh so it stays inside the retention window
      value = hit.value;
      hits++;
    } else {
      const rawInputs: Record<string, GraphValue> = {};
      for (const [port, ref] of Object.entries(node.inputs ?? {})) {
        rawInputs[port] = resolveRef(ref, byId, evalNode);
      }
      const impl = REGISTRY[node.type];
      if (!impl) throw new Error(`no implementation for node type "${node.type}"`);
      const { inputs, params } = resolveInputs(node.type, rawInputs, node.params ?? {}, vars);
      try {
        value = impl(inputs, params);
      } catch (e) {
        // rewrite cryptic OCCT/replicad failures into a clear, actionable message
        // and tag the failing node so the editor can highlight it
        const raw = e instanceof Error ? e.message : String(e);
        throw Object.assign(new Error(humanizeError(node.type, raw)), { nodeId: id, raw });
      }
      cache.entries.set(key, { value, run: cache.run });
      misses++;
    }

    visiting.delete(id);
    valMemo.set(id, value);
    return value;
  };

  const outputs: Record<string, GraphValue> = {};
  for (const n of graph) outputs[n.id] = evalNode(n.id);

  // evict entries untouched for more than one run (frees stale OCCT shapes)
  for (const [k, e] of cache.entries) {
    if (cache.run - e.run > 1) {
      disposeValue(e.value);
      cache.entries.delete(k);
    }
  }
  // hard LRU bound as a backstop against pathological graphs: if we're still
  // over budget, drop the oldest entries (smallest run) first.
  if (cache.entries.size > CACHE_MAX_ENTRIES) {
    const byAge = [...cache.entries.entries()].sort((a, b) => a[1].run - b[1].run);
    for (let i = 0; i < byAge.length && cache.entries.size > CACHE_MAX_ENTRIES; i++) {
      disposeValue(byAge[i][1].value);
      cache.entries.delete(byAge[i][0]);
    }
  }

  return { outputs, hits, misses };
}
