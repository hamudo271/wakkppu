import type { ThreeNS } from "./three";
import { shardVariants } from "./detail";
import { NO_AO_LAYER } from "./post";

const SHARD_KINDS = 3;
const PER_KIND = 24; // crumbs per shard shape

/**
 * Renderer, camera (그냥볼 parity), lights, environment, blob contact shadows and the crumb shards.
 * Lighting: image-based light from the studio environment plus one white key light from the upper
 * left (no flat ambient fill, so the balls keep their form); a white point light follows the
 * pressed ball for a soft specular kick and flares at the 뽀각.
 */
export class SceneRig {
  renderer: any;
  scene: any;
  camera: any;
  light: any;
  key: any;
  envTex: any;
  private blobTex: any;
  private blobGeo: any;
  private pools: { mesh: any; state: Float32Array }[] = [];
  w = 1;
  h = 1;
  wW = 1;
  wH = 1;
  pxToWorld = 1;
  private tmpM: any;
  private tmpQ: any;
  private tmpV: any;
  private tmpS: any;
  private axis: any;

  private THREE: ThreeNS;
  canvas: HTMLCanvasElement;

  constructor(THREE: ThreeNS, RoomEnvironment: any, canvas: HTMLCanvasElement) {
    this.THREE = THREE; this.canvas = canvas;
    const T = THREE;
    this.renderer = new T.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "high-performance" });
    this.renderer.outputColorSpace = T.SRGBColorSpace;
    this.renderer.toneMapping = T.ACESFilmicToneMapping;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.scene = new T.Scene();
    this.camera = new T.PerspectiveCamera(50, 1, 0.1, 200);
    this.camera.position.set(0, 0, 20);
    this.camera.lookAt(0, 0, 0);
    this.camera.layers.enable(NO_AO_LAYER); // blob shadows live there; they render with or without post-processing
    const pmrem = new T.PMREMGenerator(this.renderer);
    this.envTex = pmrem.fromScene(new RoomEnvironment()).texture;
    pmrem.dispose();
    this.scene.environment = this.envTex;
    if (this.scene.environmentRotation) this.scene.environmentRotation.x = -Math.PI / 2;
    this.key = new T.DirectionalLight(0xffffff, 1.4);
    this.key.position.set(-7, 9, 12);
    this.scene.add(this.key);
    this.light = new T.PointLight(0xffffff, 0, 0, 2);
    this.scene.add(this.light);
    // soft blob shadow: a radial gradient, darkest in the middle
    const bc = document.createElement("canvas"); bc.width = bc.height = 128;
    const g = bc.getContext("2d")!;
    const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    grd.addColorStop(0, "rgba(255,255,255,1)"); grd.addColorStop(0.45, "rgba(255,255,255,0.55)"); grd.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = grd; g.fillRect(0, 0, 128, 128);
    this.blobTex = new T.CanvasTexture(bc);
    this.blobGeo = new T.PlaneGeometry(1, 1);
    // crumbs: a few irregular wax shard shapes, instanced
    this.tmpM = new T.Matrix4(); this.tmpQ = new T.Quaternion(); this.tmpV = new T.Vector3(); this.tmpS = new T.Vector3(); this.axis = new T.Vector3();
    const shards = shardVariants(SHARD_KINDS, 7);
    for (const sg of shards) {
      const geo = new T.BufferGeometry();
      geo.setAttribute("position", new T.BufferAttribute(sg.positions, 3));
      geo.setAttribute("normal", new T.BufferAttribute(sg.normals, 3));
      geo.setIndex(new T.BufferAttribute(sg.index, 1));
      const mat = new T.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.42, metalness: 0, clearcoat: 0.8, clearcoatRoughness: 0.2 });
      const mesh = new T.InstancedMesh(geo, mat, PER_KIND);
      mesh.instanceMatrix.setUsage(T.DynamicDrawUsage);
      mesh.frustumCulled = false;
      for (let i = 0; i < PER_KIND; i++) { this.tmpM.makeScale(0, 0, 0); mesh.setMatrixAt(i, this.tmpM); mesh.setColorAt(i, new T.Color(0xffffff)); }
      this.scene.add(mesh);
      this.pools.push({ mesh, state: new Float32Array(PER_KIND * 12) }); // x y z vx vy vz t size spin ax ay az
    }
  }

  /** A blob shadow mesh for one ball (positioned by the engine every frame). */
  makeShadow() {
    const T = this.THREE;
    const m = new T.Mesh(this.blobGeo, new T.MeshBasicMaterial({ map: this.blobTex, color: 0x0a0c1e, transparent: true, opacity: 0.3, depthWrite: false, toneMapped: false }));
    m.renderOrder = -1;
    m.frustumCulled = false;
    m.layers.set(NO_AO_LAYER);
    this.scene.add(m);
    return m;
  }

  dropShadow(m: any) { this.scene.remove(m); m.material.dispose(); }

  resize(w: number, h: number) {
    this.w = w; this.h = h;
    const aspect = w / h;
    const maxAspect = 1.5;
    let fov = 50;
    if (aspect > maxAspect) fov = (2 * Math.atan(Math.tan((25 * Math.PI) / 180) * (maxAspect / aspect)) * 180) / Math.PI;
    this.camera.fov = fov; this.camera.aspect = aspect; this.camera.updateProjectionMatrix();
    this.wH = 2 * Math.tan((fov * Math.PI) / 360) * 20;
    this.wW = this.wH * aspect;
    this.pxToWorld = this.wH / h;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(w, h, false);
    this.canvas.style.width = w + "px"; this.canvas.style.height = h + "px";
  }

  worldX(cx: number) { return ((cx / this.w) * 2 - 1) * (this.wW / 2); }
  worldY(cy: number) { return -((cy / this.h) * 2 - 1) * (this.wH / 2); }

  flare = 0; // extra light intensity, decays each frame

  setLightTarget(x: number, y: number, R: number, on: boolean) {
    this.light.intensity = (on ? 22 : 0) + this.flare;
    this.light.position.set(x - R * 0.5, y + R * 0.6, R * 2.4);
  }

  stepFlare(dt: number) { this.flare *= Math.exp(-dt / 0.12); if (this.flare < 1) this.flare = 0; }

  spawnCrumbs(x: number, y: number, z: number, dx: number, dy: number, dz: number, R: number, color: string, n: number) {
    const T = this.THREE;
    const c = new T.Color(color);
    let placed = 0;
    for (let k = 0; k < this.pools.length * PER_KIND && placed < n; k++) {
      const pool = this.pools[k % this.pools.length], i = Math.floor(k / this.pools.length), o = i * 12, s = pool.state;
      if (s[o + 6] > 0) continue;
      const a = Math.random() * Math.PI * 2, sp = (0.3 + Math.random() * 0.5) * R;
      s[o] = x + dx * R * 0.9; s[o + 1] = y + dy * R * 0.9; s[o + 2] = z + dz * R * 0.9;
      s[o + 3] = dx * sp + Math.cos(a) * sp * 0.6; s[o + 4] = dy * sp + Math.sin(a) * sp * 0.6 + 0.4 * R; s[o + 5] = dz * sp;
      s[o + 6] = 0.7 + Math.random() * 0.4; s[o + 7] = (0.05 + Math.random() * 0.07) * R; s[o + 8] = Math.random() * 6;
      const ax = Math.random() - 0.5, ay = Math.random() - 0.5, az = Math.random() - 0.5, al = Math.hypot(ax, ay, az) || 1;
      s[o + 9] = ax / al; s[o + 10] = ay / al; s[o + 11] = az / al;
      pool.mesh.setColorAt(i, c);
      pool.mesh.instanceColor.needsUpdate = true;
      placed++;
    }
  }

  /** The crushed lump falling apart: shards from all over its face drop away, spinning (pooled, nothing allocated). */
  spawnFall(x: number, y: number, R: number, colors: string[], n: number) {
    const T = this.THREE;
    const cols = colors.map((c) => new T.Color(c));
    let placed = 0;
    for (let k = 0; k < this.pools.length * PER_KIND && placed < n; k++) {
      const pool = this.pools[k % this.pools.length], i = Math.floor(k / this.pools.length), o = i * 12, s = pool.state;
      if (s[o + 6] > 0) continue;
      const a = Math.random() * Math.PI * 2, rr = Math.sqrt(Math.random()) * 0.85 * R, f = rr / R;
      s[o] = x + Math.cos(a) * rr; s[o + 1] = y + Math.sin(a) * rr; s[o + 2] = Math.sqrt(Math.max(0, R * R - rr * rr)) * 0.9;
      const out = (0.25 + Math.random() * 0.45) * R;
      s[o + 3] = Math.cos(a) * out * f; s[o + 4] = Math.sin(a) * out * f * 0.4 + (Math.random() * 0.25 - 0.05) * R; s[o + 5] = Math.random() * 0.3 * R;
      s[o + 6] = 0.5 + Math.random() * 0.35; s[o + 7] = (0.08 + Math.random() * 0.1) * R; s[o + 8] = Math.random() * 6;
      const ax = Math.random() - 0.5, ay = Math.random() - 0.5, az = Math.random() - 0.5, al = Math.hypot(ax, ay, az) || 1;
      s[o + 9] = ax / al; s[o + 10] = ay / al; s[o + 11] = az / al;
      pool.mesh.setColorAt(i, cols[Math.floor(Math.random() * cols.length)]);
      pool.mesh.instanceColor.needsUpdate = true;
      placed++;
    }
  }

  stepCrumbs(dt: number, gravity: number) {
    for (const pool of this.pools) {
      const s = pool.state;
      for (let i = 0; i < PER_KIND; i++) {
        const o = i * 12;
        let t = s[o + 6];
        if (t <= 0) { this.tmpM.makeScale(0, 0, 0); pool.mesh.setMatrixAt(i, this.tmpM); continue; }
        s[o + 4] -= gravity * dt;
        s[o] += s[o + 3] * dt; s[o + 1] += s[o + 4] * dt; s[o + 2] += s[o + 5] * dt;
        s[o + 8] += dt * 5;
        t -= dt; s[o + 6] = t;
        const sz = s[o + 7] * Math.min(1, t / 0.25);
        this.tmpV.set(s[o], s[o + 1], s[o + 2]);
        this.tmpQ.setFromAxisAngle(this.axis.set(s[o + 9], s[o + 10], s[o + 11]), s[o + 8]);
        this.tmpS.set(sz, sz, sz);
        this.tmpM.compose(this.tmpV, this.tmpQ, this.tmpS);
        pool.mesh.setMatrixAt(i, this.tmpM);
      }
      pool.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  /** Camera shake offset in CSS px; returns nothing, the caller renders (directly or through post-processing). */
  applyShake(shakeX: number, shakeY: number) {
    this.camera.position.x = shakeX * this.pxToWorld;
    this.camera.position.y = shakeY * this.pxToWorld;
  }

  render(shakeX: number, shakeY: number) {
    this.applyShake(shakeX, shakeY);
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    for (const p of this.pools) { p.mesh.geometry.dispose(); p.mesh.material.dispose(); }
    this.blobTex.dispose(); this.blobGeo.dispose();
    this.envTex?.dispose();
    this.renderer.dispose();
  }
}
