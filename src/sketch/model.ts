/**
 * Data model for the constraint-based 2D sketcher (Fusion-style).
 *
 * A sketch is a bag of POINTS, ENTITIES (that reference points) and CONSTRAINTS
 * (geometric relations + driving dimensions). The solver (./solver) moves the
 * points/radii so every constraint is satisfied. Driving dimensions carry a
 * `name` and become editable parameters on the resulting Sketch node, so
 * changing a value re-solves the sketch and updates the 3D live.
 *
 * This module is framework-free on purpose: it is imported both by the kernel
 * (node evaluation, in the worker) and by the React editor (live drag-solve).
 */

export type Id = string;

export interface SPoint {
  id: Id;
  x: number;
  y: number;
  /** anchored: excluded from the solver's unknowns (stays put) */
  fixed?: boolean;
}

// `construction: true` marks reference geometry — drawn dashed, used for
// constraints/symmetry but excluded from the closed profile fed to Extrude.
export type Entity =
  | { id: Id; kind: "line"; p1: Id; p2: Id; construction?: boolean }
  /** circle: centre point + a radius DOF */
  | { id: Id; kind: "circle"; c: Id; r: number; construction?: boolean }
  /**
   * arc: centre + two endpoints. The radius is implied by |c-p1|; an internal
   * consistency residual keeps |c-p2| equal to it. `ccw` picks the sweep side.
   */
  | { id: Id; kind: "arc"; c: Id; p1: Id; p2: Id; ccw: boolean; construction?: boolean }
  /** spline: a smooth curve through its control points (open chain) */
  | { id: Id; kind: "spline"; pts: Id[]; construction?: boolean };

export type EntityKind = Entity["kind"];

/** Geometric (non-dimensional) constraints. */
export type GeoConstraint =
  | { id: Id; kind: "coincident"; a: Id; b: Id }
  | { id: Id; kind: "horizontal"; line: Id }
  | { id: Id; kind: "vertical"; line: Id }
  | { id: Id; kind: "parallel"; a: Id; b: Id }
  | { id: Id; kind: "perpendicular"; a: Id; b: Id }
  | { id: Id; kind: "equal"; a: Id; b: Id }
  | { id: Id; kind: "tangent"; a: Id; b: Id }
  | { id: Id; kind: "pointOn"; p: Id; ent: Id }
  | { id: Id; kind: "midpoint"; p: Id; line: Id }
  | { id: Id; kind: "symmetric"; a: Id; b: Id; line: Id }
  | { id: Id; kind: "fixed"; p: Id };

/** Dimensional (driving) constraints — these surface as node parameters. */
export type DimConstraint =
  | { id: Id; kind: "distance"; a: Id; b: Id; value: number; name: string }
  | { id: Id; kind: "distanceX"; a: Id; b: Id; value: number; name: string }
  | { id: Id; kind: "distanceY"; a: Id; b: Id; value: number; name: string }
  | { id: Id; kind: "radius"; ent: Id; value: number; name: string }
  | { id: Id; kind: "angle"; a: Id; b: Id; value: number; name: string };

export type Constraint = GeoConstraint | DimConstraint;
export type ConstraintKind = Constraint["kind"];

const DIM_KINDS = new Set<ConstraintKind>(["distance", "distanceX", "distanceY", "radius", "angle"]);
export function isDim(c: Constraint): c is DimConstraint {
  return DIM_KINDS.has(c.kind);
}

export interface SketchDoc {
  /** onto which base plane the sketch is placed when shown/extruded in 3D */
  plane: "XY" | "XZ" | "YZ";
  points: SPoint[];
  entities: Entity[];
  constraints: Constraint[];
  /** monotonically increasing counter for fresh ids */
  seq: number;
}

export function emptyDoc(plane: SketchDoc["plane"] = "XY"): SketchDoc {
  return { plane, points: [], entities: [], constraints: [], seq: 1 };
}

/** Deep clone (documents are plain JSON — safe to structured-clone). */
export function cloneDoc(d: SketchDoc): SketchDoc {
  return {
    plane: d.plane,
    seq: d.seq,
    points: d.points.map((p) => ({ ...p })),
    entities: d.entities.map((e) => ({ ...e }) as Entity),
    constraints: d.constraints.map((c) => ({ ...c }) as Constraint),
  };
}

export function nextId(d: SketchDoc, prefix: string): Id {
  return `${prefix}${d.seq++}`;
}

/* -------------------------------------------------------------------------- */
/* Lookup helpers                                                             */
/* -------------------------------------------------------------------------- */

export function pointMap(d: SketchDoc): Map<Id, SPoint> {
  return new Map(d.points.map((p) => [p.id, p]));
}

export function getPoint(d: SketchDoc, id: Id): SPoint {
  const p = d.points.find((q) => q.id === id);
  if (!p) throw new Error(`sketch: unknown point ${id}`);
  return p;
}

export function getEntity(d: SketchDoc, id: Id): Entity {
  const e = d.entities.find((q) => q.id === id);
  if (!e) throw new Error(`sketch: unknown entity ${id}`);
  return e;
}

/** All point ids an entity depends on (for hit-testing / deletion). */
export function entityPoints(e: Entity): Id[] {
  switch (e.kind) {
    case "line": return [e.p1, e.p2];
    case "circle": return [e.c];
    case "arc": return [e.c, e.p1, e.p2];
    case "spline": return [...e.pts];
  }
}

/* -------------------------------------------------------------------------- */
/* Mutation helpers (used by the editor & by snapping)                        */
/* -------------------------------------------------------------------------- */

export function addPoint(d: SketchDoc, x: number, y: number, fixed = false): SPoint {
  const p: SPoint = { id: nextId(d, "p"), x, y, ...(fixed ? { fixed: true } : {}) };
  d.points.push(p);
  return p;
}

/**
 * Merge point `dead` into `keep`: every entity/constraint referencing `dead`
 * now points at `keep`, and `dead` is removed. This is how snapping welds
 * coincident endpoints (cheaper & more stable than a coincident residual).
 */
export function mergePoints(d: SketchDoc, keep: Id, dead: Id): void {
  if (keep === dead) return;
  for (const e of d.entities) {
    if (e.kind === "line") { if (e.p1 === dead) e.p1 = keep; if (e.p2 === dead) e.p2 = keep; }
    else if (e.kind === "circle") { if (e.c === dead) e.c = keep; }
    else if (e.kind === "arc") { if (e.c === dead) e.c = keep; if (e.p1 === dead) e.p1 = keep; if (e.p2 === dead) e.p2 = keep; }
    else if (e.kind === "spline") { e.pts = e.pts.map((p) => (p === dead ? keep : p)); }
  }
  for (const c of d.constraints) {
    for (const k of ["a", "b", "p", "line", "ent"] as const) {
      if ((c as Record<string, unknown>)[k] === dead) (c as Record<string, unknown>)[k] = keep;
    }
  }
  d.points = d.points.filter((p) => p.id !== dead);
}

/** Remove an entity and any of its points/constraints left dangling. */
export function deleteEntity(d: SketchDoc, entId: Id): void {
  const ent = d.entities.find((e) => e.id === entId);
  if (!ent) return;
  d.entities = d.entities.filter((e) => e.id !== entId);
  // drop constraints that reference the entity directly
  d.constraints = d.constraints.filter(
    (c) => !("ent" in c && c.ent === entId) && !("a" in c && c.a === entId) && !("b" in c && c.b === entId),
  );
  // drop points no longer used by any remaining entity
  const used = new Set<Id>();
  for (const e of d.entities) for (const p of entityPoints(e)) used.add(p);
  const removed = new Set<Id>();
  for (const p of entityPoints(ent)) if (!used.has(p)) removed.add(p);
  d.points = d.points.filter((p) => !removed.has(p.id));
  d.constraints = d.constraints.filter((c) => {
    for (const k of ["a", "b", "p", "line"] as const) {
      const v = (c as Record<string, unknown>)[k];
      if (typeof v === "string" && removed.has(v)) return false;
    }
    return true;
  });
}

/** Driving dimensions in document order (their names map to node params). */
export function dimensions(d: SketchDoc): DimConstraint[] {
  return d.constraints.filter(isDim);
}

/** A fresh, unique dimension name like d1 / r2 / a3. */
export function freshDimName(d: SketchDoc, kind: DimConstraint["kind"]): string {
  const prefix = kind === "radius" ? "r" : kind === "angle" ? "a" : "d";
  const taken = new Set(dimensions(d).map((x) => x.name));
  for (let i = 1; ; i++) {
    const n = `${prefix}${i}`;
    if (!taken.has(n)) return n;
  }
}
