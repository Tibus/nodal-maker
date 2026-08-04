/**
 * Three.js viewport. Renders a MeshPayload and colours each triangle group by
 * its semantic tag, so "flagged" faces (top cap / contour sides / bottom) are
 * visible at a glance.
 */
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import type { MeshPayload, FaceTag } from "./kernel/nodes";

const TAG_COLORS: Record<FaceTag, number> = {
  top: 0xff8c42, // orange  — the cap we re-select
  side: 0x4a90d9, // blue    — contour faces
  bottom: 0x8a8f98, // gray  — base
};

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
  private measures: THREE.Object3D[] = [];
  private edgesObj: THREE.LineSegments | null = null;
  private modelDiag = 100;
  // Fusion-style display: shaded / shaded+edges / wireframe (edges only)
  private viewMode: "shaded" | "edges" | "wireframe" = "shaded";
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
    this.camera.position.set(120, 90, 120);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;

    const grid = new THREE.GridHelper(400, 40, 0x333842, 0x2a2e36);
    this.scene.add(grid);

    const hemi = new THREE.HemisphereLight(0xffffff, 0x33383f, 1.0);
    this.scene.add(hemi);
    const key = new THREE.DirectionalLight(0xffffff, 1.4);
    key.position.set(80, 160, 100);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.5);
    fill.position.set(-100, 40, -80);
    this.scene.add(fill);

    // materials indexed to match the geometry groups we build below
    this.materials = [
      new THREE.MeshStandardMaterial({ color: TAG_COLORS.top, roughness: 0.55, metalness: 0.1 }),
      new THREE.MeshStandardMaterial({ color: TAG_COLORS.side, roughness: 0.6, metalness: 0.1 }),
      new THREE.MeshStandardMaterial({ color: TAG_COLORS.bottom, roughness: 0.7, metalness: 0.1 }),
    ];

    window.addEventListener("resize", () => this.onResize(container));
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

    const mesh = new THREE.Mesh(geom, this.materials);
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
    if (reframe || !this.framed) {
      this.frameCamera(box);
      this.framed = true;
    } else if (!box.isEmpty()) {
      // keep the orbit pivot on the model even when we don't re-frame
      this.controls.target.copy(box.getCenter(new THREE.Vector3()));
    }
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
    // a sketch always shows as bright line-work on its plane (no filled plate)
    if (this.isSketchView) {
      if (this.mesh) this.mesh.visible = false;
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
      this.mesh.material = this.materials; // restore per-tag materials + groups
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
    if (this.brepEdges) (this.brepEdges.material as THREE.Material).clippingPlanes = planes;
    if (this.extraGroup) this.extraGroup.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments) (o.material as THREE.Material).clippingPlanes = planes;
    });
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
    this.camera.position.set(
      center.x + radius * 1.6,
      center.y + radius * 1.4,
      center.z + radius * 1.6,
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
    return { axis: f.axis, offset: f.offset, tag: f.tag, centroid: f.centroid };
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
  pickBorder(clientX: number, clientY: number): { axis: "X" | "Y" | "Z"; offset: number } | null {
    const f = this.detectFace(clientX, clientY);
    if (!f || f.axis === "curved" || !this.edgesObj) return null;
    const ai = f.axis === "X" ? 0 : f.axis === "Y" ? 1 : 2;
    const pos = this.edgesObj.geometry.getAttribute("position");
    const epsPlane = Math.max(0.05, this.modelDiag * 0.004);
    const pad = this.modelDiag * 0.02;
    const inFace = (x: number, y: number, z: number) => {
      const p = [x, y, z];
      for (let a = 0; a < 3; a++) if (a !== ai && (p[a] < f.min[a] - pad || p[a] > f.max[a] + pad)) return false;
      return Math.abs(p[ai] - f.offset) <= epsPlane;
    };
    // collect border segments (both endpoints in the face's plane + extent)
    const segs: number[] = [];
    for (let i = 0; i < pos.count; i += 2) {
      const ax = pos.getX(i), ay = pos.getY(i), az = pos.getZ(i);
      const bx = pos.getX(i + 1), by = pos.getY(i + 1), bz = pos.getZ(i + 1);
      if (inFace(ax, ay, az) && inFace(bx, by, bz)) segs.push(ax, ay, az, bx, by, bz);
    }
    this.clearPick();
    if (segs.length === 0) return { axis: f.axis, offset: f.offset }; // plane known even if no edge drawn
    const r = Math.max(0.4, this.modelDiag * 0.006);
    const group = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({ color: 0x39d98a, depthTest: false });
    for (let i = 0; i < segs.length; i += 6) {
      const a = new THREE.Vector3(segs[i], segs[i + 1], segs[i + 2]);
      const b = new THREE.Vector3(segs[i + 3], segs[i + 4], segs[i + 5]);
      const tube = new THREE.Mesh(new THREE.TubeGeometry(new THREE.LineCurve3(a, b), 1, r, 5, false), mat);
      tube.renderOrder = 999;
      group.add(tube);
    }
    this.scene.add(group);
    this.pickHighlight = group;
    return { axis: f.axis, offset: f.offset };
  }

  /**
   * Ray-pick the feature EDGE nearest a screen point. Returns an Edge Select
   * descriptor: the axis the edge runs along (→ vertical / horizontal-x/-y), or
   * if it lies flat in a horizontal plane, `atZ` with that plane's offset.
   */
  pickEdge(clientX: number, clientY: number): { where: string; offset: number } | null {
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

    return { where, offset: Math.round(offset * 100) / 100 };
  }

  private onResize(container: HTMLElement) {
    this.camera.aspect = container.clientWidth / container.clientHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(container.clientWidth, container.clientHeight);
  }

  private animate = () => {
    requestAnimationFrame(this.animate);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };
}
