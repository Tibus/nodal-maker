/**
 * Three.js viewport. Renders a MeshPayload and colours each triangle group by
 * its semantic tag, so "flagged" faces (top cap / contour sides / bottom) are
 * visible at a glance.
 */
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
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

  setGeometry(payload: MeshPayload) {
    if (this.mesh) {
      this.scene.remove(this.mesh);
      this.mesh.geometry.dispose();
      this.mesh = null;
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(payload.vertices, 3));
    geom.setAttribute("normal", new THREE.BufferAttribute(payload.normals, 3));
    geom.setIndex(new THREE.BufferAttribute(payload.indices, 1));

    // one draw-group per B-rep face group, pointing at the tag's material
    geom.clearGroups();
    for (const g of payload.groups) {
      geom.addGroup(g.start, g.count, this.matIndexFor(g.tag));
    }

    const mesh = new THREE.Mesh(geom, this.materials);
    this.scene.add(mesh);
    this.mesh = mesh;

    this.frameObject(mesh);
  }

  private frameObject(obj: THREE.Object3D) {
    const box = new THREE.Box3().setFromObject(obj);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    // center the model on the grid
    obj.position.sub(center);
    obj.position.y += size.y / 2;

    const radius = Math.max(size.x, size.y, size.z);
    this.controls.target.set(0, size.y / 2, 0);
    this.camera.position.set(radius * 1.6, radius * 1.4, radius * 1.6);
    this.camera.near = radius / 100;
    this.camera.far = radius * 100;
    this.camera.updateProjectionMatrix();
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
