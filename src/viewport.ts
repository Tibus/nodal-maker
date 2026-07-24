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
  private edgesObj: THREE.LineSegments | null = null;
  private modelDiag = 100;
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

  /** Remove the picked-face/edge highlight overlay. */
  clearPick() {
    if (this.pickHighlight) {
      this.scene.remove(this.pickHighlight);
      const g = (this.pickHighlight as THREE.Mesh).geometry;
      if (g) g.dispose();
      this.pickHighlight = null;
    }
  }

  /**
   * Ray-pick the face under a screen point. Returns a descriptor a Face Select
   * node can be configured from: which axis-aligned plane the face lies in (or
   * "curved"/cylindrical) and the plane offset. Also highlights the face.
   */
  pickFace(clientX: number, clientY: number): {
    axis: "X" | "Y" | "Z" | "curved";
    offset: number;
    tag: FaceTag;
    centroid: [number, number, number];
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

    // which draw group (= one B-rep / mesh face) owns the hit triangle?
    const idx = hit.faceIndex * 3;
    const group = this.payload.groups.find((g) => idx >= g.start && idx < g.start + g.count);
    if (!group) return null;

    // average the group's vertex normals + gather its coordinate extents
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

    // dominant axis of the face normal → the plane it lies in, if flat
    const comp = [Math.abs(n.x), Math.abs(n.y), Math.abs(n.z)];
    const dom = comp[0] >= comp[1] && comp[0] >= comp[2] ? 0 : comp[1] >= comp[2] ? 1 : 2;
    const spread = max[dom] - min[dom]; // ~0 for a plane perpendicular to `dom`
    const diag = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
    const flat = comp[dom] > 0.9 && spread < Math.max(0.05, diag * 0.02);
    const axis = flat ? (["X", "Y", "Z"] as const)[dom] : "curved";
    const offset = flat ? centroid[dom] : 0;

    // highlight the picked group's triangles
    this.clearPick();
    const hgeom = new THREE.BufferGeometry();
    const pos = new Float32Array(group.count * 3);
    for (let i = 0; i < group.count; i++) {
      const v = indices[group.start + i] * 3;
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

    return { axis, offset: Math.round(offset * 100) / 100, tag: group.tag, centroid };
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
