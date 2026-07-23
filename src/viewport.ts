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
  // 3D translation gizmo (edits a Transform node's tx/ty/tz)
  private gizmo: TransformControls | null = null;
  private gizmoProxy: THREE.Object3D | null = null;
  private gizmoDragging = false;
  private onGizmoMove: ((pos: [number, number, number]) => void) | null = null;
  /** object centre with the node's translation removed — stable drag reference */
  private gizmoBase = new THREE.Vector3();

  constructor(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
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

    const box = new THREE.Box3().setFromObject(mesh);
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
  showTranslateGizmo(
    translation: [number, number, number],
    onMove: (t: [number, number, number]) => void,
  ) {
    this.onGizmoMove = onMove;
    const center = this.mesh
      ? new THREE.Box3().setFromObject(this.mesh).getCenter(new THREE.Vector3())
      : new THREE.Vector3();

    if (!this.gizmo) {
      this.gizmoProxy = new THREE.Object3D();
      this.scene.add(this.gizmoProxy);
      this.gizmo = new TransformControls(this.camera, this.renderer.domElement);
      this.gizmo.setMode("translate");
      this.gizmo.setSize(0.9);
      this.gizmo.attach(this.gizmoProxy);
      this.scene.add(this.gizmo as unknown as THREE.Object3D);
      this.gizmo.addEventListener("dragging-changed", (e) => {
        this.gizmoDragging = (e as unknown as { value: boolean }).value;
        this.controls.enabled = !this.gizmoDragging;
      });
      this.gizmo.addEventListener("objectChange", () => {
        const p = this.gizmoProxy!.position;
        this.onGizmoMove?.([
          p.x - this.gizmoBase.x,
          p.y - this.gizmoBase.y,
          p.z - this.gizmoBase.z,
        ]);
      });
    }
    if (!this.gizmoDragging && this.gizmoProxy) {
      // un-translated centre = current centre − applied translation
      this.gizmoBase.copy(center).sub(new THREE.Vector3(...translation));
      this.gizmoProxy.position.copy(center);
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
    this.onGizmoMove = null;
    this.controls.enabled = true;
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
