/**
 * Three.js viewport. Renders a MeshPayload and colours each triangle group by
 * its semantic tag, so "flagged" faces (top cap / contour sides / bottom) are
 * visible at a glance.
 */
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import type { MeshPayload, FaceTag } from "./kernel/nodes";

// Fusion-style: one neutral gray for every face (orientation is read from the
// shading, not the colour). Face tags still drive picking, just not the tint.
const BODY_GRAY = 0xb4b8bf;

export class Viewport {
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private mesh: THREE.Mesh | null = null;
  private materials: THREE.Material[];
  private framed = false;
  private payload: MeshPayload | null = null;
  private raycaster = new THREE.Raycaster();
  private pickHighlight: THREE.Object3D | null = null;
  // Persistent "what does this selection node target" overlay — rebuilt after
  // every re-eval (unlike pickHighlight, which is a one-shot pick flash).
  // transient highlight when hovering a node's selection OUTPUT port
  private portHl: THREE.Object3D | null = null;
  // persistent highlight of the feature a selected modifier acts on
  private featureHl: THREE.Object3D | null = null;
  private measures: THREE.Object3D[] = [];
  private edgesObj: THREE.LineSegments | null = null;
  private modelDiag = 100;
  // world AABB of the current model — pick signatures are stored relative to it
  private modelBox = { min: [0, 0, 0] as number[], max: [1, 1, 1] as number[] };
  // Fusion-style display: shaded / shaded+edges / wireframe (edges only)
  private viewMode: "shaded" | "edges" | "wireframe" = "edges";
  private brepEdges: THREE.LineSegments | null = null;
  // pinned-visible extra bodies (for assembling several B-reps) — non-pickable
  private extraGroup: THREE.Group | null = null;
  // the current payload is a 2D sketch → show it as line-work on its plane
  private isSketchView = false;
  // section view: active clipping planes (empty = off)
  private clip: THREE.Plane[] = [];
  // print-analysis overlay (overhang / wall-thickness) as vertex colours
  private analysis: { mode: "overhang" | "thickness"; angle: number; minWall: number } | null = null;
  private analysisMat: THREE.MeshStandardMaterial | null = null;
  private tintMat: THREE.MeshStandardMaterial | null = null;
  private grid: THREE.GridHelper | null = null;
  // section-cap: fills the cut surface via the stencil buffer (a solid section,
  // not a hollow hole). Holds two stencil passes + the cap plane.
  private capGroup: THREE.Group | null = null;
  private outlineObj: THREE.LineSegments | null = null;
  // flat fill for 2D sketch previews (double-sided so it shows from any angle)
  private sketchMat = new THREE.MeshBasicMaterial({ color: 0xc678dd, transparent: true, opacity: 0.32, side: THREE.DoubleSide, depthWrite: false });
  // 3D translation gizmo (edits a Transform node's tx/ty/tz)
  private gizmo: TransformControls | null = null;
  private gizmoProxy: THREE.Object3D | null = null;
  private gizmoDragging = false;
  private gizmoMode: "translate" | "rotate" | "scale" = "translate";
  private gizmoAxis: "X" | "Y" | "Z" = "Z";
  private onTranslate: ((t: [number, number, number]) => void) | null = null;
  private onRotate: ((deg: number) => void) | null = null;
  private onScale: ((factor: number) => void) | null = null;
  /** object centre with the node's translation removed — stable drag reference */
  private gizmoBase = new THREE.Vector3();

  constructor(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.localClippingEnabled = true; // section-view clipping planes
    this.renderer.shadowMap.enabled = true;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x1a1d23);

    this.camera = new THREE.PerspectiveCamera(
      45,
      container.clientWidth / container.clientHeight,
      0.1,
      5000,
    );
    // Z-up world (CAD convention): the model's +Z is up on screen
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(150, -150, 120);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;

    // ground grid lies in the XY plane (the Z-up floor)
    const grid = new THREE.GridHelper(400, 40, 0x333842, 0x2a2e36);
    grid.rotation.x = Math.PI / 2;
    this.scene.add(grid);
    this.grid = grid;

    const hemi = new THREE.HemisphereLight(0xffffff, 0x33383f, 1.0);
    this.scene.add(hemi);
    const key = new THREE.DirectionalLight(0xffffff, 1.4);
    key.position.set(100, -120, 180); // above (+Z) and to the front
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.5);
    fill.position.set(-100, 80, 60);
    this.scene.add(fill);

    // materials indexed to match the geometry groups we build below — all the
    // same neutral gray (Fusion look); the tag grouping still serves picking.
    const bodyMat = () => new THREE.MeshStandardMaterial({ color: BODY_GRAY, roughness: 0.5, metalness: 0.12 });
    this.materials = [bodyMat(), bodyMat(), bodyMat()];

    window.addEventListener("resize", () => this.onResize(container));
    // also track the container itself so the split-pane resizer (which doesn't
    // fire a window resize) keeps the canvas aspect correct
    new ResizeObserver(() => this.onResize(container)).observe(container);
    this.animate();
  }

  private matIndexFor(tag: FaceTag): number {
    return tag === "top" ? 0 : tag === "side" ? 1 : 2;
  }

  /**
   * Render a mesh payload. Geometry stays in TRUE model coordinates (no
   * recentering) so the translation gizmo lines up with it. The camera only
   * re-frames on the first payload (or when `reframe` is forced), keeping the
   * view stable during live param/gizmo editing.
   */
  setGeometry(payload: MeshPayload, reframe = false) {
    if (this.mesh) {
      this.scene.remove(this.mesh);
      this.mesh.geometry.dispose();
      this.mesh = null;
    }
    this.clearPick();
    this.clearPortHighlight(); // drop any hover highlight tied to the old geometry
    this.payload = payload;
    this.isSketchView = !!payload.isSketch;

    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(payload.vertices, 3));
    geom.setAttribute("normal", new THREE.BufferAttribute(payload.normals, 3));
    geom.setIndex(new THREE.BufferAttribute(payload.indices, 1));

    geom.clearGroups();
    for (const g of payload.groups) {
      geom.addGroup(g.start, g.count, this.matIndexFor(g.tag));
    }

    // whole-body tint from a Color node overrides the per-tag materials
    if (this.tintMat) { this.tintMat.dispose(); this.tintMat = null; }
    if (payload.tint) this.tintMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(payload.tint), roughness: 0.55, metalness: 0.1 });
    // 2D profiles render as a flat filled region; solids use the gray body mats
    const mesh = new THREE.Mesh(geom, payload.isSketch ? this.sketchMat : (this.tintMat ?? this.materials));
    this.scene.add(mesh);
    this.mesh = mesh;

    // a feature-edge line set kept off-scene purely as a raycast target for
    // edge picking (built from the mesh by dihedral angle threshold)
    if (this.edgesObj) this.edgesObj.geometry.dispose();
    const eg = new THREE.EdgesGeometry(geom, 18);
    this.edgesObj = new THREE.LineSegments(eg, new THREE.LineBasicMaterial());
    this.edgesObj.updateMatrixWorld();

    // Fusion-style construction wireframe: prefer the real B-rep edges shipped
    // in the payload; for mesh-domain payloads (no B-rep) fall back to the
    // dihedral feature edges so wireframe mode still shows something sensible.
    if (this.brepEdges) {
      this.scene.remove(this.brepEdges);
      this.brepEdges.geometry.dispose();
      this.brepEdges = null;
    }
    let lineGeom: THREE.BufferGeometry;
    if (payload.edges && payload.edges.length) {
      lineGeom = new THREE.BufferGeometry();
      lineGeom.setAttribute("position", new THREE.BufferAttribute(payload.edges, 3));
    } else {
      lineGeom = eg.clone();
    }
    this.brepEdges = new THREE.LineSegments(
      lineGeom,
      new THREE.LineBasicMaterial({ color: 0x101418 }),
    );
    this.brepEdges.renderOrder = 1;
    this.scene.add(this.brepEdges);
    this.applyViewMode();
    this.applyClip(); // keep any active section plane on the new geometry
    this.applyAnalysis(); // re-apply any overhang/thickness overlay after re-eval

    const box = new THREE.Box3().setFromObject(mesh);
    this.modelDiag = Math.max(box.getSize(new THREE.Vector3()).length(), 1);
    this.modelBox = { min: [box.min.x, box.min.y, box.min.z], max: [box.max.x, box.max.y, box.max.z] };
    if (reframe || !this.framed) {
      this.frameCamera(box);
      this.framed = true;
    }
    // otherwise leave the camera exactly where the user put it — tweaking a
    // parameter must NOT re-centre or re-frame the view (only changing the
    // viewed node does, via reframe=true from the caller).
  }

  /**
   * Cycle/choose the display mode:
   *  - "shaded":    solid faces only
   *  - "edges":     solid faces + construction edges overlaid (default Fusion look)
   *  - "wireframe": construction edges only, faces hidden
   */
  setViewMode(mode: "shaded" | "edges" | "wireframe") {
    this.viewMode = mode;
    this.applyViewMode();
  }

  getViewMode(): "shaded" | "edges" | "wireframe" {
    return this.viewMode;
  }

  private applyViewMode() {
    // a 2D sketch shows as a flat FILLED region + its bright outline on-plane
    if (this.isSketchView) {
      if (this.mesh) this.mesh.visible = true;
      if (this.brepEdges) {
        this.brepEdges.visible = true;
        (this.brepEdges.material as THREE.LineBasicMaterial).color.setHex(0x39d0ff);
      }
      return;
    }
    if (this.mesh) this.mesh.visible = this.viewMode !== "wireframe";
    if (this.brepEdges) {
      this.brepEdges.visible = this.viewMode !== "shaded";
      // dark edges read well over the shaded solid; over the dark empty
      // background (wireframe) they need to be light instead
      (this.brepEdges.material as THREE.LineBasicMaterial).color.setHex(
        this.viewMode === "wireframe" ? 0xcfd6de : 0x101418,
      );
    }
    if (this.extraGroup) {
      for (const o of this.extraGroup.children) {
        if (o instanceof THREE.Mesh) o.visible = this.viewMode !== "wireframe";
        else if (o instanceof THREE.LineSegments) {
          o.visible = this.viewMode !== "shaded";
          (o.material as THREE.LineBasicMaterial).color.setHex(
            this.viewMode === "wireframe" ? 0x8fa0b3 : 0x24333f,
          );
        }
      }
    }
  }

  /**
   * Toggle a print-analysis overlay that recolours the model per-vertex:
   *  - "overhang":  red where a down-facing surface is steeper than `angle`
   *                 (from vertical) and would need supports.
   *  - "thickness": red where the local wall is thinner than `minWall`
   *                 (measured by casting a ray inward and hitting the far wall).
   * Pass null to restore the normal tag-coloured shading.
   */
  setAnalysis(a: { mode: "overhang" | "thickness"; angle: number; minWall: number } | null) {
    this.analysis = a;
    this.applyAnalysis();
  }

  private applyAnalysis() {
    if (!this.mesh || !this.payload || this.isSketchView) return;
    const geom = this.mesh.geometry;
    if (!this.analysis) {
      geom.deleteAttribute("color");
      this.mesh.material = this.tintMat ?? this.materials; // restore tint or per-tag materials
      return;
    }
    const colors = this.analysis.mode === "overhang" ? this.overhangColors(this.analysis.angle) : this.thicknessColors(this.analysis.minWall);
    geom.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    if (!this.analysisMat) this.analysisMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.65, metalness: 0.04 });
    this.analysisMat.clippingPlanes = this.clip.length ? this.clip : null;
    this.mesh.material = this.analysisMat; // single material → geometry groups ignored
  }

  /** Per-vertex colours flagging down-facing overhangs steeper than `angle`. */
  private overhangColors(angle: number): Float32Array {
    const n = this.payload!.normals;
    const N = this.payload!.vertices.length / 3;
    const cosT = Math.cos((angle * Math.PI) / 180); // support if -nz > cosT
    const col = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      const d = -n[i * 3 + 2]; // downward component (1 = faces straight down)
      const s = Math.max(0, Math.min(1, (d - cosT) / Math.max(1e-3, 1 - cosT)));
      // neutral grey → hot red as the overhang worsens
      col[i * 3] = 0.62 + s * 0.32;
      col[i * 3 + 1] = 0.63 - s * 0.47;
      col[i * 3 + 2] = 0.66 - s * 0.5;
    }
    return col;
  }

  /** Per-vertex colours flagging walls thinner than `minWall` (ray to far side). */
  private thicknessColors(minWall: number): Float32Array {
    const { vertices, normals } = this.payload!;
    const N = vertices.length / 3;
    const col = new Float32Array(N * 3);
    // a double-sided proxy so inward rays register the opposite (back) wall
    const proxy = new THREE.Mesh(this.mesh!.geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
    proxy.updateMatrixWorld();
    const ray = new THREE.Raycaster();
    const eps = Math.max(1e-3, this.modelDiag * 1e-4);
    const o = new THREE.Vector3(), dir = new THREE.Vector3();
    for (let i = 0; i < N; i++) {
      const vx = vertices[i * 3], vy = vertices[i * 3 + 1], vz = vertices[i * 3 + 2];
      dir.set(-normals[i * 3], -normals[i * 3 + 1], -normals[i * 3 + 2]).normalize();
      o.set(vx + dir.x * eps, vy + dir.y * eps, vz + dir.z * eps);
      ray.set(o, dir);
      const hit = ray.intersectObject(proxy, false)[0];
      const t = hit ? hit.distance + eps : Infinity;
      // s: 0 = fine (>=minWall), 1 = paper-thin
      const s = t >= minWall ? 0 : 1 - t / minWall;
      col[i * 3] = 0.62 + s * 0.32;
      col[i * 3 + 1] = 0.63 - s * 0.47;
      col[i * 3 + 2] = 0.66 - s * 0.5;
    }
    (proxy.material as THREE.Material).dispose();
    return col;
  }

  /**
   * Render pinned-visible extra bodies alongside the main model. They are drawn
   * with a distinct translucent material and their B-rep edges, but are NOT
   * raycast targets (picking always acts on the main output). Pass [] to clear.
   */
  setExtraBodies(bodies: { id: string; mesh: MeshPayload }[]) {
    if (this.extraGroup) {
      this.scene.remove(this.extraGroup);
      this.extraGroup.traverse((o) => {
        if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments) o.geometry.dispose();
      });
      this.extraGroup = null;
    }
    if (!bodies.length) return;

    const group = new THREE.Group();
    const faceMat = new THREE.MeshStandardMaterial({
      color: 0x6b8fb5,
      metalness: 0.1,
      roughness: 0.75,
      transparent: true,
      opacity: 0.55,
      side: THREE.DoubleSide,
    });
    for (const b of bodies) {
      const p = b.mesh;
      const geom = new THREE.BufferGeometry();
      geom.setAttribute("position", new THREE.BufferAttribute(p.vertices, 3));
      geom.setAttribute("normal", new THREE.BufferAttribute(p.normals, 3));
      geom.setIndex(new THREE.BufferAttribute(p.indices, 1));
      const bodyMesh = new THREE.Mesh(geom, faceMat);
      bodyMesh.visible = this.viewMode !== "wireframe";
      group.add(bodyMesh);

      let lineGeom: THREE.BufferGeometry | null = null;
      if (p.edges && p.edges.length) {
        lineGeom = new THREE.BufferGeometry();
        lineGeom.setAttribute("position", new THREE.BufferAttribute(p.edges, 3));
      } else {
        lineGeom = new THREE.EdgesGeometry(geom, 18);
      }
      const lines = new THREE.LineSegments(lineGeom, new THREE.LineBasicMaterial({ color: 0x24333f }));
      lines.visible = this.viewMode !== "shaded";
      group.add(lines);
    }
    this.scene.add(group);
    this.extraGroup = group;
    this.applyViewMode();
  }

  /**
   * Section view: clip everything past a plane at `offset` along `axis`.
   * `flip` shows the other half. Pass axis=null to turn it off.
   */
  setClip(axis: "X" | "Y" | "Z" | null, offset = 0, flip = false) {
    if (!axis) {
      this.clip = [];
    } else {
      const n = new THREE.Vector3(axis === "X" ? 1 : 0, axis === "Y" ? 1 : 0, axis === "Z" ? 1 : 0);
      if (flip) n.negate();
      // keep the half where n·p + c < 0 → c = -(n·offset) = -(offset) along axis
      this.clip = [new THREE.Plane(n, flip ? offset : -offset)];
    }
    this.applyClip();
  }

  private applyClip() {
    const planes = this.clip;
    for (const m of this.materials) (m as THREE.Material).clippingPlanes = planes;
    if (this.analysisMat) this.analysisMat.clippingPlanes = planes.length ? planes : null;
    if (this.tintMat) this.tintMat.clippingPlanes = planes.length ? planes : null;
    if (this.brepEdges) (this.brepEdges.material as THREE.Material).clippingPlanes = planes;
    if (this.extraGroup) this.extraGroup.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments) (o.material as THREE.Material).clippingPlanes = planes;
    });
    this.buildCap();
    this.buildSectionOutline();
  }

  private clearOutline() {
    if (!this.outlineObj) return;
    this.scene.remove(this.outlineObj);
    this.outlineObj.geometry.dispose();
    (this.outlineObj.material as THREE.Material).dispose();
    this.outlineObj = null;
  }

  /**
   * The section outline: for every mesh triangle the clip plane crosses, add the
   * segment where the plane cuts it. Together they trace the exact cross-section
   * boundary — a crisp wireframe on the cut, recomputed as the plane moves.
   */
  private buildSectionOutline() {
    this.clearOutline();
    if (!this.mesh || this.clip.length === 0 || this.isSketchView) return;
    const plane = this.clip[0];
    const geom = this.mesh.geometry;
    const pos = geom.getAttribute("position") as THREE.BufferAttribute;
    const index = geom.getIndex();
    const count = index ? index.count : pos.count;
    const vi = (i: number) => (index ? index.getX(i) : i);
    const pts: number[] = [];
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    const eps = this.modelDiag * 0.0015; // lift toward the viewer so it beats the cap fill
    const edge = (p: THREE.Vector3, dp: number, q: THREE.Vector3, dq: number) => {
      if ((dp < 0) === (dq < 0)) return; // no sign change → plane doesn't cross this edge
      const t = dp / (dp - dq);
      pts.push(p.x + (q.x - p.x) * t - plane.normal.x * eps, p.y + (q.y - p.y) * t - plane.normal.y * eps, p.z + (q.z - p.z) * t - plane.normal.z * eps);
    };
    for (let t = 0; t + 2 < count; t += 3) {
      a.fromBufferAttribute(pos, vi(t)); b.fromBufferAttribute(pos, vi(t + 1)); c.fromBufferAttribute(pos, vi(t + 2));
      const da = plane.distanceToPoint(a), db = plane.distanceToPoint(b), dc = plane.distanceToPoint(c);
      const before = pts.length;
      edge(a, da, b, db); edge(b, db, c, dc); edge(c, dc, a, da);
      if (pts.length - before !== 6) pts.length = before; // keep only clean 2-point crossings
    }
    if (!pts.length) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    const line = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0xffcc00 }));
    line.renderOrder = 3;
    this.scene.add(line);
    this.outlineObj = line;
  }

  private clearCap() {
    if (!this.capGroup) return;
    this.scene.remove(this.capGroup);
    this.capGroup.traverse((o) => {
      const g = (o as THREE.Mesh).geometry;
      if (g && g !== this.mesh?.geometry) g.dispose(); // never dispose the shared model geometry
      const m = (o as THREE.Mesh).material;
      if (m) (Array.isArray(m) ? m : [m]).forEach((x) => { (x as THREE.MeshStandardMaterial).map?.dispose(); x.dispose(); });
    });
    this.capGroup = null;
  }

  /**
   * Fill the section cut. Two stencil passes mark the solid interior at the
   * plane (back faces increment, front faces decrement the stencil), then a
   * big plane draws the cap only where the stencil is non-zero.
   */
  private buildCap() {
    this.clearCap();
    if (!this.mesh || this.clip.length === 0 || this.isSketchView) return;
    const plane = this.clip[0];
    const geom = this.mesh.geometry;
    const group = new THREE.Group();

    const stencilMat = (side: THREE.Side, op: THREE.StencilOp) => {
      const m = new THREE.MeshBasicMaterial();
      m.depthWrite = false; m.depthTest = false; m.colorWrite = false;
      m.stencilWrite = true; m.stencilFunc = THREE.AlwaysStencilFunc;
      m.side = side; m.clippingPlanes = [plane];
      m.stencilFail = m.stencilZFail = m.stencilZPass = op;
      return m;
    };
    const back = new THREE.Mesh(geom, stencilMat(THREE.BackSide, THREE.IncrementWrapStencilOp));
    const front = new THREE.Mesh(geom, stencilMat(THREE.FrontSide, THREE.DecrementWrapStencilOp));
    back.renderOrder = 1; front.renderOrder = 1;
    group.add(back, front);

    const size = this.modelDiag * 2;
    const hatch = this.hatchTexture();
    const rep = Math.max(24, Math.round(size / 2)); // ~2 mm world spacing (fine hatch)
    hatch.repeat.set(rep, rep);
    // unlit (MeshBasic): the section fill must read the same whatever the plane
    // faces — a lit material left the Y-normal cap in shadow.
    const capMat = new THREE.MeshBasicMaterial({
      color: 0xffffff, side: THREE.DoubleSide, map: hatch,
      stencilWrite: true, stencilRef: 0, stencilFunc: THREE.NotEqualStencilFunc,
      stencilFail: THREE.ReplaceStencilOp, stencilZFail: THREE.ReplaceStencilOp, stencilZPass: THREE.ReplaceStencilOp,
    });
    const cap = new THREE.Mesh(new THREE.PlaneGeometry(size, size), capMat);
    cap.renderOrder = 2;
    cap.onAfterRender = (r) => r.clearStencil(); // reset for the next frame
    group.add(cap);

    this.scene.add(group);
    this.capGroup = group;
    this.positionCap();
  }

  /** A tiling diagonal-hatch texture for the section cap (Fusion-style). */
  private hatchTexture(): THREE.CanvasTexture {
    const s = 32;
    const c = document.createElement("canvas");
    c.width = c.height = s;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#f2ead0"; ctx.fillRect(0, 0, s, s); // light yellow fill
    ctx.strokeStyle = "#d8c260"; ctx.lineWidth = 2; ctx.lineCap = "square"; // clear yellow lines
    // one 45° line + its wrap corners so tiling stays continuous
    for (const [x0, y0, x1, y1] of [[0, s, s, 0], [-s / 2, s / 2, s / 2, -s / 2], [s / 2, 3 * s / 2, 3 * s / 2, s / 2]]) {
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    }
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    // no mipmaps → thin diagonal lines don't get averaged away when the cap
    // plane is heavily minified in the distance
    tex.generateMipmaps = false;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.anisotropy = 8;
    return tex;
  }

  /** Place & orient the cap plane onto the active clipping plane. */
  private positionCap() {
    if (!this.capGroup || !this.clip.length) return;
    const plane = this.clip[0];
    const cap = this.capGroup.children[2] as THREE.Mesh;
    plane.coplanarPoint(cap.position);
    cap.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), plane.normal.clone().negate());
  }

  /** Force the next setGeometry to re-frame the camera (used on first load). */
  reframeOnNext() {
    this.framed = false;
  }

  /** Re-frame the camera on the current model now (Fit control). */
  fit() {
    if (this.mesh) this.frameCamera(new THREE.Box3().setFromObject(this.mesh));
  }

  /** Render now and return a PNG data URL of the viewport. */
  snapshotPNG(): string {
    this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement.toDataURL("image/png");
  }

  /** Override the scene background (e.g. to match a thumbnail tile). */
  setBackground(hex: number): void {
    this.scene.background = new THREE.Color(hex);
  }

  /** Show/hide the ground grid (hidden for clean thumbnails). */
  setGridVisible(v: boolean): void {
    if (this.grid) this.grid.visible = v;
  }

  /** Render, then downscale the frame to a `size`×`size` PNG (supersampled AA). */
  snapshotScaled(size = 256): string {
    this.renderer.render(this.scene, this.camera);
    const src = this.renderer.domElement;
    const c = document.createElement("canvas");
    c.width = size; c.height = size;
    const ctx = c.getContext("2d")!;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    const s = Math.min(src.width, src.height); // centre-crop to square, then fit
    ctx.drawImage(src, (src.width - s) / 2, (src.height - s) / 2, s, s, 0, 0, size, size);
    return c.toDataURL("image/png");
  }

  /** Look straight down the Z axis — a flat top view for 2D profiles. */
  topView() {
    if (!this.mesh) return;
    const box = new THREE.Box3().setFromObject(this.mesh);
    if (box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(size.x, size.y, 1);
    this.controls.target.copy(center);
    this.camera.position.set(center.x, center.y, center.z + radius * 2.2);
    this.camera.up.set(0, 1, 0);
    this.camera.near = radius / 100;
    this.camera.far = radius * 100;
    this.camera.updateProjectionMatrix();
  }

  /** Aim the camera at the model without moving the model itself. */
  private frameCamera(box: THREE.Box3) {
    if (box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(size.x, size.y, size.z, 1);
    this.controls.target.copy(center);
    this.camera.up.set(0, 0, 1); // restore Z-up (topView may have set Y-up)
    this.camera.position.set(
      center.x + radius * 1.6,
      center.y - radius * 1.6,
      center.z + radius * 1.4,
    );
    this.camera.near = radius / 100;
    this.camera.far = radius * 100;
    this.camera.updateProjectionMatrix();
  }

  /**
   * Show a translation gizmo sitting on the current model, editing a Transform
   * node whose translation is `translation`. `onMove` fires with the new
   * translation as the user drags. The gizmo anchors to the object centre for
   * grabbability; dragging is converted back to a translation relative to the
   * (stable) un-translated centre. While dragging we leave it alone so eval
   * feedback doesn't fight the user; otherwise it re-snaps to the model.
   */
  private ensureGizmo() {
    if (this.gizmo) return;
    this.gizmoProxy = new THREE.Object3D();
    this.scene.add(this.gizmoProxy);
    this.gizmo = new TransformControls(this.camera, this.renderer.domElement);
    this.gizmo.setSize(0.9);
    this.gizmo.attach(this.gizmoProxy);
    this.scene.add(this.gizmo as unknown as THREE.Object3D);
    this.gizmo.addEventListener("dragging-changed", (e) => {
      this.gizmoDragging = (e as unknown as { value: boolean }).value;
      this.controls.enabled = !this.gizmoDragging;
    });
    this.gizmo.addEventListener("objectChange", () => {
      const p = this.gizmoProxy!;
      if (this.gizmoMode === "translate") {
        this.onTranslate?.([p.position.x - this.gizmoBase.x, p.position.y - this.gizmoBase.y, p.position.z - this.gizmoBase.z]);
      } else if (this.gizmoMode === "rotate") {
        const e = p.rotation;
        const rad = this.gizmoAxis === "X" ? e.x : this.gizmoAxis === "Y" ? e.y : e.z;
        this.onRotate?.((rad * 180) / Math.PI);
      } else {
        this.onScale?.(p.scale.x);
      }
    });
  }

  private modelCenter(): THREE.Vector3 {
    return this.mesh
      ? new THREE.Box3().setFromObject(this.mesh).getCenter(new THREE.Vector3())
      : new THREE.Vector3();
  }

  showTranslateGizmo(translation: [number, number, number], onMove: (t: [number, number, number]) => void) {
    this.ensureGizmo();
    this.gizmoMode = "translate";
    this.onTranslate = onMove;
    this.onRotate = this.onScale = null;
    this.gizmo!.setMode("translate");
    this.gizmo!.showX = this.gizmo!.showY = this.gizmo!.showZ = true;
    if (!this.gizmoDragging && this.gizmoProxy) {
      const center = this.modelCenter();
      this.gizmoBase.copy(center).sub(new THREE.Vector3(...translation));
      this.gizmoProxy.position.copy(center);
      this.gizmoProxy.rotation.set(0, 0, 0);
      this.gizmoProxy.scale.set(1, 1, 1);
    }
  }

  showRotateGizmo(axis: "X" | "Y" | "Z", angleDeg: number, onMove: (deg: number) => void) {
    this.ensureGizmo();
    this.gizmoMode = "rotate";
    this.gizmoAxis = axis;
    this.onRotate = onMove;
    this.onTranslate = this.onScale = null;
    this.gizmo!.setMode("rotate");
    this.gizmo!.showX = axis === "X";
    this.gizmo!.showY = axis === "Y";
    this.gizmo!.showZ = axis === "Z";
    if (!this.gizmoDragging && this.gizmoProxy) {
      this.gizmoProxy.position.copy(this.modelCenter());
      this.gizmoProxy.scale.set(1, 1, 1);
      const rad = (angleDeg * Math.PI) / 180;
      this.gizmoProxy.rotation.set(axis === "X" ? rad : 0, axis === "Y" ? rad : 0, axis === "Z" ? rad : 0);
    }
  }

  showScaleGizmo(factor: number, onMove: (f: number) => void) {
    this.ensureGizmo();
    this.gizmoMode = "scale";
    this.onScale = onMove;
    this.onTranslate = this.onRotate = null;
    this.gizmo!.setMode("scale");
    this.gizmo!.showX = this.gizmo!.showY = this.gizmo!.showZ = true;
    if (!this.gizmoDragging && this.gizmoProxy) {
      this.gizmoProxy.position.copy(this.modelCenter());
      this.gizmoProxy.rotation.set(0, 0, 0);
      this.gizmoProxy.scale.set(factor, factor, factor);
    }
  }

  hideGizmo() {
    if (!this.gizmo) return;
    this.gizmo.detach();
    this.scene.remove(this.gizmo as unknown as THREE.Object3D);
    this.gizmo.dispose();
    this.gizmo = null;
    if (this.gizmoProxy) this.scene.remove(this.gizmoProxy);
    this.gizmoProxy = null;
    this.onTranslate = this.onRotate = this.onScale = null;
    this.controls.enabled = true;
  }

  /** Remove the picked-face/edge/border highlight overlay. */
  clearPick() {
    if (this.pickHighlight) {
      this.scene.remove(this.pickHighlight);
      this.pickHighlight.traverse((o) => {
        const g = (o as THREE.Mesh).geometry;
        if (g) g.dispose();
      });
      this.pickHighlight = null;
    }
  }

  /** Raycast the model surface and return the world-space hit point (for Measure). */
  pickPoint(clientX: number, clientY: number): [number, number, number] | null {
    if (!this.mesh) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = this.raycaster.intersectObject(this.mesh, false)[0];
    if (!hit) return null;
    return [hit.point.x, hit.point.y, hit.point.z];
  }

  /** Remove ALL measurement overlays (lines, markers, labels). */
  clearMeasure() {
    for (const m of this.measures) {
      this.scene.remove(m);
      m.traverse((o) => {
        const g = (o as THREE.Mesh).geometry; if (g) g.dispose();
        const sp = o as THREE.Sprite;
        if (sp.isSprite) (sp.material.map as THREE.Texture | null)?.dispose();
      });
    }
    this.measures = [];
  }

  /** A canvas-textured sprite showing the dimension text, sized in world units. */
  private dimLabel(text: string, at: THREE.Vector3): THREE.Sprite {
    const pad = 8, fs = 48;
    const cv = document.createElement("canvas");
    const ctx = cv.getContext("2d")!;
    ctx.font = `bold ${fs}px sans-serif`;
    const w = Math.ceil(ctx.measureText(text).width) + pad * 2;
    cv.width = w; cv.height = fs + pad * 2;
    ctx.font = `bold ${fs}px sans-serif`;
    ctx.fillStyle = "rgba(20,22,28,0.85)";
    ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.fillStyle = "#ffcc00";
    ctx.textBaseline = "middle";
    ctx.fillText(text, pad, cv.height / 2);
    const tex = new THREE.CanvasTexture(cv);
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
    const scale = this.modelDiag * 0.06;
    sp.scale.set((scale * cv.width) / cv.height, scale, 1);
    sp.position.copy(at);
    sp.renderOrder = 1000;
    return sp;
  }

  /** Add a persistent measurement (line + endpoint markers + distance label). */
  showMeasure(a: [number, number, number], b: [number, number, number]): number {
    const grp = new THREE.Group();
    const va = new THREE.Vector3(...a), vb = new THREE.Vector3(...b);
    const geo = new THREE.BufferGeometry().setFromPoints([va, vb]);
    const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xffcc00, depthTest: false }));
    line.renderOrder = 999;
    grp.add(line);
    const r = Math.max(0.4, this.modelDiag * 0.006);
    const dotMat = new THREE.MeshBasicMaterial({ color: 0xffcc00, depthTest: false });
    for (const v of [va, vb]) {
      const dot = new THREE.Mesh(new THREE.SphereGeometry(r, 12, 12), dotMat);
      dot.position.copy(v);
      dot.renderOrder = 999;
      grp.add(dot);
    }
    const dist = va.distanceTo(vb);
    grp.add(this.dimLabel(`${dist.toFixed(2)} mm`, va.clone().add(vb).multiplyScalar(0.5)));
    this.scene.add(grp);
    this.measures.push(grp);
    return dist;
  }

  /**
   * Ray-pick the face under a screen point. Returns a descriptor a Face Select
   * node can be configured from: which axis-aligned plane the face lies in (or
   * "curved"/cylindrical) and the plane offset. Also highlights the face.
   */
  /**
   * Hover preview for pick modes: highlights exactly what a click would select,
   * reusing the pick detection. `border` highlights the flat face whose rim
   * would be taken. Returns true when something is under the cursor. */
  hoverHighlight(mode: "face" | "edge" | "border", clientX: number, clientY: number): boolean {
    const hit =
      mode === "edge" ? this.pickEdge(clientX, clientY)
      : mode === "border" ? this.pickBorder(clientX, clientY)
      : this.pickFace(clientX, clientY);
    if (!hit) this.clearPick(); // moved off the model → drop the stale highlight
    return hit != null;
  }

  /** Raycast a face and describe it (no highlight). Shared by pickFace/pickBorder. */
  private detectFace(clientX: number, clientY: number): {
    axis: "X" | "Y" | "Z" | "curved";
    offset: number;
    tag: FaceTag;
    centroid: [number, number, number];
    group: { start: number; count: number };
    min: number[];
    max: number[];
  } | null {
    if (!this.mesh || !this.payload) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = this.raycaster.intersectObject(this.mesh, false)[0];
    if (!hit || hit.faceIndex == null) return null;

    const idx = hit.faceIndex * 3;
    const group = this.payload.groups.find((g) => idx >= g.start && idx < g.start + g.count);
    if (!group) return null;

    const { vertices, normals, indices } = this.payload;
    const n = new THREE.Vector3();
    let cx = 0, cy = 0, cz = 0, count = 0;
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = group.start; i < group.start + group.count; i++) {
      const v = indices[i] * 3;
      n.x += normals[v]; n.y += normals[v + 1]; n.z += normals[v + 2];
      cx += vertices[v]; cy += vertices[v + 1]; cz += vertices[v + 2];
      for (let a = 0; a < 3; a++) {
        min[a] = Math.min(min[a], vertices[v + a]);
        max[a] = Math.max(max[a], vertices[v + a]);
      }
      count++;
    }
    if (count === 0) return null;
    n.normalize();
    const centroid: [number, number, number] = [cx / count, cy / count, cz / count];

    const comp = [Math.abs(n.x), Math.abs(n.y), Math.abs(n.z)];
    const dom = comp[0] >= comp[1] && comp[0] >= comp[2] ? 0 : comp[1] >= comp[2] ? 1 : 2;
    const spread = max[dom] - min[dom];
    const diag = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
    const flat = comp[dom] > 0.9 && spread < Math.max(0.05, diag * 0.02);
    const axis = flat ? (["X", "Y", "Z"] as const)[dom] : "curved";
    const offset = flat ? centroid[dom] : 0;
    return { axis, offset: Math.round(offset * 100) / 100, tag: group.tag, centroid, group, min, max };
  }

  pickFace(clientX: number, clientY: number): {
    axis: "X" | "Y" | "Z" | "curved";
    offset: number;
    tag: FaceTag;
    centroid: [number, number, number];
    /** the picked face's world AABB — lets a Face Select isolate THIS face */
    box: [number, number, number, number, number, number];
    /** bbox-relative signature so a Face Select re-binds to THIS face on change */
    ref: { kind: "face"; posRel: [number, number, number]; normal: [number, number, number]; surf: "planar" | "cylindrical" | "other" };
  } | null {
    const f = this.detectFace(clientX, clientY);
    if (!f) return null;
    const { vertices, indices } = this.payload!;
    // highlight the picked face's triangles (translucent fill)
    this.clearPick();
    const hgeom = new THREE.BufferGeometry();
    const pos = new Float32Array(f.group.count * 3);
    for (let i = 0; i < f.group.count; i++) {
      const v = indices[f.group.start + i] * 3;
      pos[i * 3] = vertices[v]; pos[i * 3 + 1] = vertices[v + 1]; pos[i * 3 + 2] = vertices[v + 2];
    }
    hgeom.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    const hmesh = new THREE.Mesh(
      hgeom,
      new THREE.MeshBasicMaterial({ color: 0x39d98a, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthTest: false }),
    );
    hmesh.renderOrder = 999;
    this.scene.add(hmesh);
    this.pickHighlight = hmesh;
    // pad the AABB slightly so a tight box still contains the whole B-rep face
    const pad = Math.max(0.05, this.modelDiag * 0.01);
    // averaged normal over the face group → part of its re-bind signature
    const { normals: nrm, indices: idx } = this.payload!;
    let nx = 0, ny = 0, nz = 0;
    for (let i = f.group.start; i < f.group.start + f.group.count; i++) { const v = idx[i] * 3; nx += nrm[v]; ny += nrm[v + 1]; nz += nrm[v + 2]; }
    const nl = Math.hypot(nx, ny, nz) || 1;
    return {
      axis: f.axis, offset: f.offset, tag: f.tag, centroid: f.centroid,
      box: [f.min[0] - pad, f.min[1] - pad, f.min[2] - pad, f.max[0] + pad, f.max[1] + pad, f.max[2] + pad],
      ref: { kind: "face", posRel: this.relPos(f.centroid), normal: [nx / nl, ny / nl, nz / nl], surf: f.axis === "curved" ? "cylindrical" : "planar" },
    };
  }

  /**
   * Pick any PLANAR face (including tilted, non-axis-aligned ones) and return a
   * placement frame for a sketch: an origin on the face, its outward normal
   * (extrusion direction) and a stable local +X axis. Returns null if the face
   * under the cursor is curved (not planar). Highlights the face like pickFace.
   */
  pickFacePlane(clientX: number, clientY: number): { origin: [number, number, number]; normal: [number, number, number]; xDir: [number, number, number] } | null {
    const f = this.detectFace(clientX, clientY);
    if (!f || !this.payload) return null;
    const { vertices, normals, indices } = this.payload;
    // averaged normal over the face group
    let nx = 0, ny = 0, nz = 0;
    for (let i = f.group.start; i < f.group.start + f.group.count; i++) {
      const v = indices[i] * 3;
      nx += normals[v]; ny += normals[v + 1]; nz += normals[v + 2];
    }
    const nl = Math.hypot(nx, ny, nz) || 1;
    const n: [number, number, number] = [nx / nl, ny / nl, nz / nl];
    const o = f.centroid;
    // planarity test: every group vertex must lie near the plane (o, n)
    const diag = Math.hypot(f.max[0] - f.min[0], f.max[1] - f.min[1], f.max[2] - f.min[2]) || 1;
    const tol = Math.max(0.05, diag * 0.02);
    for (let i = f.group.start; i < f.group.start + f.group.count; i++) {
      const v = indices[i] * 3;
      const d = (vertices[v] - o[0]) * n[0] + (vertices[v + 1] - o[1]) * n[1] + (vertices[v + 2] - o[2]) * n[2];
      if (Math.abs(d) > tol) return null; // curved face
    }
    // local +X: cross the world axis least aligned with n, then normalize
    const ax = Math.abs(n[0]), ay = Math.abs(n[1]), az = Math.abs(n[2]);
    const up: [number, number, number] = ax <= ay && ax <= az ? [1, 0, 0] : ay <= az ? [0, 1, 0] : [0, 0, 1];
    let xx = up[1] * n[2] - up[2] * n[1], xy = up[2] * n[0] - up[0] * n[2], xz = up[0] * n[1] - up[1] * n[0];
    const xl = Math.hypot(xx, xy, xz) || 1;
    xx /= xl; xy /= xl; xz /= xl;
    // reuse pickFace's highlight
    this.pickFace(clientX, clientY);
    return { origin: o, normal: n, xDir: [xx, xy, xz] };
  }

  /**
   * The picked face's outline, projected to its base plane's 2D coordinates —
   * to seed a "sketch on face" with reference geometry. Prefers the clean B-rep
   * edges; falls back to the face's triangle boundary for shapes whose edges
   * aren't available (e.g. compounds). Returns segments [[x1,y1],[x2,y2]].
   */
  faceOutline2D(base: "XY" | "XZ" | "YZ", offset: number): [number, number][][] {
    const [nrm, u, v] = base === "XY" ? [2, 0, 1] : base === "XZ" ? [1, 0, 2] : [0, 1, 2];
    const out: [number, number][][] = [];
    const edges = this.payload?.edges;
    if (edges) {
      const tol = 0.05;
      for (let i = 0; i + 5 < edges.length; i += 6) {
        const a = [edges[i], edges[i + 1], edges[i + 2]];
        const b = [edges[i + 3], edges[i + 4], edges[i + 5]];
        if (Math.abs(a[nrm] - offset) > tol || Math.abs(b[nrm] - offset) > tol) continue;
        out.push([[a[u], a[v]], [b[u], b[v]]]);
      }
    }
    if (out.length > 0) return out;

    // fallback: boundary of every triangle lying IN the plane (edges used by a
    // single in-plane triangle). Captures the outer outline AND inner loops /
    // holes at this offset — works even for compounds with no B-rep edges.
    if (!this.payload) return out;
    const { vertices, indices } = this.payload;
    const tol = 0.05;
    const onPlane = (vi: number) => Math.abs(vertices[vi * 3 + nrm] - offset) < tol;
    const edge = new Map<string, { a: number; b: number; n: number }>();
    for (let t = 0; t + 2 < indices.length; t += 3) {
      const tri = [indices[t], indices[t + 1], indices[t + 2]];
      if (!onPlane(tri[0]) || !onPlane(tri[1]) || !onPlane(tri[2])) continue; // triangle not on the plane
      for (let e = 0; e < 3; e++) {
        const a = tri[e], b = tri[(e + 1) % 3];
        const key = a < b ? `${a}_${b}` : `${b}_${a}`;
        const rec = edge.get(key);
        if (rec) rec.n++;
        else edge.set(key, { a, b, n: 1 });
      }
    }
    for (const { a, b, n } of edge.values()) {
      if (n !== 1) continue; // interior (shared) edge
      const pa = a * 3, pb = b * 3;
      out.push([[vertices[pa + u], vertices[pa + v]], [vertices[pb + u], vertices[pb + v]]]);
    }
    return out;
  }

  /**
   * Pick a flat face and highlight its BORDER — the feature edges lying in the
   * face's plane, within its extent — rather than the face fill. Returns the
   * plane (axis + offset) so an Edge Select can target that rim.
   */
  pickBorder(
    clientX: number,
    clientY: number,
  ): {
    axis: "X" | "Y" | "Z"; offset: number; near?: [number, number, number];
    ref?: { kind: "edge"; posRel: [number, number, number]; dir: [number, number, number] };
  } | null {
    const f = this.detectFace(clientX, clientY);
    if (!f || f.axis === "curved") return null;
    const ai = f.axis === "X" ? 0 : f.axis === "Y" ? 1 : 2;
    const epsPlane = Math.max(0.05, this.modelDiag * 0.004);
    const pad = this.modelDiag * 0.02;
    const inFace = (x: number, y: number, z: number) => {
      const p = [x, y, z];
      for (let a = 0; a < 3; a++) if (a !== ai && (p[a] < f.min[a] - pad || p[a] > f.max[a] + pad)) return false;
      return Math.abs(p[ai] - f.offset) <= epsPlane;
    };

    // Prefer the real B-rep edges (their tessellation nodes lie EXACTLY on the
    // curve, so a returned point is a valid `containsPoint` target). Fall back to
    // the dihedral mesh edges when no B-rep is available — but then we can't emit
    // a precise `near`, so the selection stays plane-wide (both loops).
    const brep = this.payload?.edges;
    const usingBrep = !!(brep && brep.length);
    const readSeg = (i: number): [number, number, number, number, number, number] | null => {
      if (usingBrep) {
        const e = brep as Float32Array;
        return [e[i], e[i + 1], e[i + 2], e[i + 3], e[i + 4], e[i + 5]];
      }
      const pos = this.edgesObj?.geometry.getAttribute("position");
      if (!pos) return null;
      const j = i / 3; // fallback iterates by vertex pairs, not by 6-float stride
      return [pos.getX(j), pos.getY(j), pos.getZ(j), pos.getX(j + 1), pos.getY(j + 1), pos.getZ(j + 1)];
    };
    const stride = usingBrep ? 6 : 6; // both advance one segment (2 verts) at a time
    const total = usingBrep ? (brep as Float32Array).length : (this.edgesObj?.geometry.getAttribute("position").count ?? 0) * 3;

    // Border segments = both endpoints inside the face's plane + extent.
    type Seg = { a: [number, number, number]; b: [number, number, number] };
    const segs: Seg[] = [];
    for (let i = 0; i + 5 < total; i += stride) {
      const s = readSeg(i);
      if (!s) continue;
      if (inFace(s[0], s[1], s[2]) && inFace(s[3], s[4], s[5])) {
        segs.push({ a: [s[0], s[1], s[2]], b: [s[3], s[4], s[5]] });
      }
    }
    this.clearPick();
    if (segs.length === 0) return { axis: f.axis, offset: f.offset }; // plane known even if no edge drawn

    // Group segments into connected loops (union-find over quantised endpoints),
    // then keep only the loop nearest the click — so concentric rims separate.
    const q = Math.max(this.modelDiag * 1e-4, 1e-5);
    const key = (p: [number, number, number]) =>
      `${Math.round(p[0] / q)}_${Math.round(p[1] / q)}_${Math.round(p[2] / q)}`;
    const parent: number[] = [];
    const nodeOf = new Map<string, number>();
    const idOf = (p: [number, number, number]) => {
      const k = key(p);
      let id = nodeOf.get(k);
      if (id == null) { id = parent.length; parent.push(id); nodeOf.set(k, id); }
      return id;
    };
    const find = (x: number): number => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    const seedNode: number[] = [];
    for (const s of segs) { const ia = idOf(s.a), ib = idOf(s.b); parent[find(ia)] = find(ib); seedNode.push(ia); }
    const loops = new Map<number, Seg[]>();
    segs.forEach((s, i) => {
      const root = find(seedNode[i]);
      const arr = loops.get(root) ?? (loops.set(root, []), loops.get(root)!);
      arr.push(s);
    });

    // click point on the surface → choose the loop whose nearest segment is closest
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    const surfHit = this.mesh ? this.raycaster.intersectObject(this.mesh, false)[0] : undefined;
    const cp = surfHit ? surfHit.point : new THREE.Vector3(...f.centroid);
    const va = new THREE.Vector3(), vb = new THREE.Vector3(), ab = new THREE.Vector3(), ap = new THREE.Vector3(), pr = new THREE.Vector3();
    const distToSeg = (s: Seg) => {
      va.set(...s.a); vb.set(...s.b); ab.subVectors(vb, va);
      const t = Math.min(1, Math.max(0, ap.subVectors(cp, va).dot(ab) / (ab.lengthSq() || 1e-9)));
      return pr.copy(va).addScaledVector(ab, t).distanceTo(cp);
    };
    let best: Seg[] = segs, bestD = Infinity;
    for (const loop of loops.values()) {
      let d = Infinity;
      for (const s of loop) d = Math.min(d, distToSeg(s));
      if (d < bestD) { bestD = d; best = loop; }
    }

    // highlight only the chosen loop
    const r = Math.max(0.4, this.modelDiag * 0.006);
    const group = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({ color: 0x39d98a, depthTest: false });
    for (const s of best) {
      const a = new THREE.Vector3(...s.a);
      const b = new THREE.Vector3(...s.b);
      const tube = new THREE.Mesh(new THREE.TubeGeometry(new THREE.LineCurve3(a, b), 1, r, 5, false), mat);
      tube.renderOrder = 999;
      group.add(tube);
    }
    this.scene.add(group);
    this.pickHighlight = group;

    // Emit a point ON the picked loop only when it came from real B-rep edges —
    // then the downstream edgeSelect can `containsPoint` it to isolate this loop.
    const near: [number, number, number] | undefined = usingBrep ? best[0].a : undefined;
    let ref: { kind: "edge"; posRel: [number, number, number]; dir: [number, number, number] } | undefined;
    if (near) {
      const d = [best[0].b[0] - best[0].a[0], best[0].b[1] - best[0].a[1], best[0].b[2] - best[0].a[2]];
      const dl = Math.hypot(d[0], d[1], d[2]) || 1;
      ref = { kind: "edge", posRel: this.relPos(near), dir: [d[0] / dl, d[1] / dl, d[2] / dl] };
    }
    return { axis: f.axis, offset: f.offset, near, ref };
  }

  /** Build a green overlay group from face triangles + edge segments (kernel B-rep).
   *  Edges → thick tubes (readable), lines only for pathologically large sets. */
  private buildHighlightGroup(tris: Float32Array, segs: Float32Array): THREE.Group | null {
    const group = new THREE.Group();
    if (tris.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(tris, 3));
      const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0x39d98a, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthTest: false }));
      mesh.renderOrder = 998;
      group.add(mesh);
    }
    if (segs.length) {
      if (segs.length / 6 <= 600) {
        const r = Math.max(0.4, this.modelDiag * 0.006);
        const mat = new THREE.MeshBasicMaterial({ color: 0x39d98a, depthTest: false });
        for (let i = 0; i + 5 < segs.length; i += 6) {
          const a = new THREE.Vector3(segs[i], segs[i + 1], segs[i + 2]);
          const b = new THREE.Vector3(segs[i + 3], segs[i + 4], segs[i + 5]);
          if (a.distanceToSquared(b) < 1e-9) continue;
          const tube = new THREE.Mesh(new THREE.TubeGeometry(new THREE.LineCurve3(a, b), 1, r, 5, false), mat);
          tube.renderOrder = 999;
          group.add(tube);
        }
      } else {
        const g = new THREE.BufferGeometry();
        g.setAttribute("position", new THREE.BufferAttribute(segs, 3));
        const lines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x39d98a, depthTest: false }));
        lines.renderOrder = 999;
        group.add(lines);
      }
    }
    return group.children.length ? group : null;
  }

  private disposeHl(o: THREE.Object3D | null) {
    if (!o) return;
    this.scene.remove(o);
    o.traverse((c) => { if (c instanceof THREE.Mesh || c instanceof THREE.LineSegments) { c.geometry.dispose(); (c.material as THREE.Material).dispose?.(); } });
  }

  /** TRANSIENT hover flash for a selection-output port (cleared on re-eval). */
  showPortHighlight(tris: Float32Array, segs: Float32Array) {
    this.clearPortHighlight();
    this.portHl = this.buildHighlightGroup(tris, segs);
    if (this.portHl) this.scene.add(this.portHl);
  }

  clearPortHighlight() {
    this.disposeHl(this.portHl);
    this.portHl = null;
  }

  /** PERSISTENT highlight of the feature a selected modifier acts on. The caller
   *  re-applies it after every eval (fresh geometry), so it survives param edits. */
  setFeatureHighlight(tris: Float32Array, segs: Float32Array) {
    this.clearFeatureHighlight();
    this.featureHl = this.buildHighlightGroup(tris, segs);
    if (this.featureHl) this.scene.add(this.featureHl);
  }

  clearFeatureHighlight() {
    this.disposeHl(this.featureHl);
    this.featureHl = null;
  }

  /** Normalise a world point into the model's AABB [0..1]³ (scale/translate
   *  invariant) — the frame in which pick signatures are stored. */
  private relPos(p: [number, number, number]): [number, number, number] {
    const mn = this.modelBox.min, mx = this.modelBox.max;
    return [(p[0] - mn[0]) / ((mx[0] - mn[0]) || 1), (p[1] - mn[1]) / ((mx[1] - mn[1]) || 1), (p[2] - mn[2]) / ((mx[2] - mn[2]) || 1)];
  }

  pickEdge(clientX: number, clientY: number): {
    where: string; offset: number; near: [number, number, number];
    ref: { kind: "edge"; posRel: [number, number, number]; dir: [number, number, number] };
  } | null {
    if (!this.edgesObj || !this.mesh) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    // Raycast the SOLID surface (reliable), then snap to the nearest feature
    // edge — far more robust than trying to ray-hit a hairline directly.
    const surf = this.raycaster.intersectObject(this.mesh, false)[0];
    if (!surf) return null;
    const p = surf.point;

    const pos = this.edgesObj.geometry.getAttribute("position");
    const va = new THREE.Vector3();
    const vb = new THREE.Vector3();
    const ab = new THREE.Vector3();
    const ap = new THREE.Vector3();
    const proj = new THREE.Vector3();
    let best = Infinity;
    let s = -1;
    for (let i = 0; i < pos.count; i += 2) {
      va.set(pos.getX(i), pos.getY(i), pos.getZ(i));
      vb.set(pos.getX(i + 1), pos.getY(i + 1), pos.getZ(i + 1));
      ab.subVectors(vb, va);
      const len2 = ab.lengthSq() || 1e-9;
      const t = Math.min(1, Math.max(0, ap.subVectors(p, va).dot(ab) / len2));
      proj.copy(va).addScaledVector(ab, t);
      const d = proj.distanceToSquared(p);
      if (d < best) { best = d; s = i; }
    }
    if (s < 0 || Math.sqrt(best) > this.modelDiag * 0.25) return null;

    const a = new THREE.Vector3(pos.getX(s), pos.getY(s), pos.getZ(s));
    const b = new THREE.Vector3(pos.getX(s + 1), pos.getY(s + 1), pos.getZ(s + 1));
    const dir = b.clone().sub(a).normalize();
    const comp = [Math.abs(dir.x), Math.abs(dir.y), Math.abs(dir.z)];
    const dom = comp[0] >= comp[1] && comp[0] >= comp[2] ? 0 : comp[1] >= comp[2] ? 1 : 2;

    let where: string;
    let offset = 0;
    if (comp[dom] > 0.9) {
      where = dom === 0 ? "horizontal-x" : dom === 1 ? "horizontal-y" : "vertical";
    } else if (Math.abs(a.z - b.z) < 0.02 * this.modelDiag) {
      where = "atZ"; // a curved/diagonal edge that stays in one horizontal plane
      offset = (a.z + b.z) / 2;
    } else {
      where = "all";
    }

    // highlight: a bright tube along the picked edge segment
    this.clearPick();
    const marker = new THREE.Mesh(
      new THREE.TubeGeometry(new THREE.LineCurve3(a, b), 1, Math.max(0.5, this.modelDiag * 0.008), 6, false),
      new THREE.MeshBasicMaterial({ color: 0x39d98a, depthTest: false }),
    );
    marker.renderOrder = 999;
    this.scene.add(marker);
    this.pickHighlight = marker;

    // reference point ON the picked edge (projection of the hit) → lets the
    // selection re-bind to this edge parametrically as the geometry changes
    const abv = b.clone().sub(a);
    const tt = Math.min(1, Math.max(0, p.clone().sub(a).dot(abv) / (abv.lengthSq() || 1e-9)));
    const refPt = a.clone().addScaledVector(abv, tt);
    const near: [number, number, number] = [refPt.x, refPt.y, refPt.z];

    return {
      where, offset: Math.round(offset * 100) / 100, near,
      ref: { kind: "edge", posRel: this.relPos(near), dir: [dir.x, dir.y, dir.z] },
    };
  }

  private onResize(container: HTMLElement) {
    this.camera.aspect = container.clientWidth / container.clientHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(container.clientWidth, container.clientHeight);
  }

  private turntable: { start: THREE.Vector3; target: THREE.Vector3; up: THREE.Vector3; t0: number; dur: number; track: CanvasCaptureMediaStreamTrack; onEnd: () => void } | null = null;

  private animate = () => {
    requestAnimationFrame(this.animate);
    if (this.turntable) {
      const tt = this.turntable;
      const t = (performance.now() - tt.t0) / 1000;
      const ang = Math.min(1, t / tt.dur) * Math.PI * 2;
      const off = tt.start.clone().sub(tt.target).applyAxisAngle(tt.up, ang);
      this.camera.position.copy(tt.target).add(off);
      this.camera.lookAt(tt.target);
      this.renderer.render(this.scene, this.camera);
      tt.track.requestFrame(); // push this freshly-drawn frame into the recording
      if (t >= tt.dur) { const end = tt.onEnd; this.turntable = null; end(); }
      return;
    }
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };

  /**
   * Record a turntable of the current model as a WebM video: spin the camera a
   * full turn around the orbit target over `durationSec`, capturing the canvas
   * via MediaRecorder. Resolves with the video Blob.
   */
  recordTurntable(durationSec = 5): Promise<Blob> {
    const canvas = this.renderer.domElement;
    // capture with no auto-fps → we push each freshly-rendered frame via
    // track.requestFrame() in animate (reliable for a rAF-driven WebGL canvas).
    const stream = canvas.captureStream(0);
    const track = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack;
    const mime = MediaRecorder.isTypeSupported("video/webm;codecs=vp9") ? "video/webm;codecs=vp9" : "video/webm";
    const rec = new MediaRecorder(stream, { mimeType: mime });
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    return new Promise((resolve, reject) => {
      rec.onstop = () => resolve(new Blob(chunks, { type: mime }));
      rec.onerror = () => reject(new Error("recording failed"));
      rec.start(100); // timeslice → flush chunks during capture
      this.turntable = {
        start: this.camera.position.clone(),
        target: this.controls.target.clone(),
        up: this.camera.up.clone().normalize(),
        t0: performance.now(),
        dur: durationSec,
        track,
        onEnd: () => rec.stop(),
      };
    });
  }
}
