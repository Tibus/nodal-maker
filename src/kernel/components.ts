/**
 * Reusable components (sub-graphs) via GRAPH EXPANSION.
 *
 * A component instance in the editor is expanded into its inner nodes before
 * the graph is evaluated, so the kernel/eval engine never has to know about
 * components — it always sees a plain flat graph. This keeps the (working)
 * evaluator and cache untouched.
 *
 * A ComponentDef captures a sub-graph + which inner ports/params/output are
 * exposed on the instance. Instances carry `component: <defId>` on their
 * descriptor, their exposed param values in `params`, and outer wires in
 * `inputs` (keyed by the exposed input-port name).
 */
import type { NodeDescriptor } from "./nodes";
import type { SocketType, ParamSpec } from "./specs";

export interface ComponentDef {
  name: string;
  /** self-contained inner sub-graph */
  nodes: NodeDescriptor[];
  /** exposed input ports → an inner node's input port */
  inputs: { name: string; type: SocketType; node: string; nodePort: string }[];
  /** exposed params → an inner node's param (spec carried for rendering) */
  params: { name: string; label: string; node: string; param: string; spec: ParamSpec }[];
  /** inner node whose value is the instance's output */
  output: string;
  /** the instance output socket type */
  outputType: SocketType;
}

/** A descriptor is a component instance when it carries a `component` def id. */
export interface InstanceDescriptor extends NodeDescriptor {
  component?: string;
}

const PX = "$"; // separator for prefixed inner node ids: `<instanceId>$<innerId>`

/**
 * Expand every component instance in `descs` into its inner nodes, wiring the
 * instance's outer inputs into the exposed inner ports, applying exposed param
 * overrides, and remapping references to an instance's output onto the inner
 * output node. Returns a flat descriptor list the evaluator can run directly.
 */
export function expandDescriptors(
  descs: InstanceDescriptor[],
  components: Record<string, ComponentDef>,
): NodeDescriptor[] {
  const out: NodeDescriptor[] = [];
  const outputAlias = new Map<string, string>(); // instanceId → inner output id

  for (const d of descs) {
    const def = d.component ? components[d.component] : undefined;
    if (!def) {
      out.push({ id: d.id, type: d.type, params: { ...(d.params ?? {}) }, inputs: { ...(d.inputs ?? {}) } });
      continue;
    }
    const px = (innerId: string) => `${d.id}${PX}${innerId}`;
    outputAlias.set(d.id, px(def.output));

    for (const inner of def.nodes) {
      const inputs: Record<string, string> = {};
      for (const [port, src] of Object.entries(inner.inputs ?? {})) inputs[port] = px(src);
      out.push({ id: px(inner.id), type: inner.type, params: { ...(inner.params ?? {}) }, inputs });
    }
    // exposed param overrides from the instance
    for (const p of def.params) {
      if (!d.params || !(p.name in d.params)) continue;
      const n = out.find((x) => x.id === px(p.node));
      if (n) n.params = { ...n.params, [p.param]: d.params[p.name] };
    }
    // wire the instance's outer inputs into the exposed inner ports
    for (const ci of def.inputs) {
      const outerSrc = d.inputs?.[ci.name];
      if (!outerSrc) continue;
      const n = out.find((x) => x.id === px(ci.node));
      if (n) n.inputs = { ...n.inputs, [ci.nodePort]: outerSrc };
    }
  }

  // any input referencing an instance id now points at that instance's inner output
  for (const n of out) {
    if (!n.inputs) continue;
    for (const [port, src] of Object.entries(n.inputs)) {
      const alias = outputAlias.get(src);
      if (alias) n.inputs[port] = alias;
    }
  }
  return out;
}

/** Remap an output node id through component expansion (instance → inner output). */
export function expandOutputId(
  outputId: string,
  descs: InstanceDescriptor[],
  components: Record<string, ComponentDef>,
): string {
  const d = descs.find((x) => x.id === outputId);
  const def = d?.component ? components[d.component] : undefined;
  return def ? `${outputId}${PX}${def.output}` : outputId;
}
