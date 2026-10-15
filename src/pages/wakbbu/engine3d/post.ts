import type { ThreeNS } from "./three";

/**
 * Post-processing (GTAO ambient occlusion + MSAA + tone mapping) and soft contact shadows for the 3D 왁뿌볼.
 *
 * CDN / module identity (checked against three@0.170.0 on jsDelivr): every `examples/jsm/.../X.js/+esm` bundle
 * used here imports exactly "/npm/three@0.170.0/+esm", which resolves to the same absolute URL three.ts loads
 * (https://cdn.jsdelivr.net/npm/three@0.170.0/+esm), so the browser hands both the SAME module instance. The
 * bundles inline their relative helpers (Pass/FullScreenQuad, CopyShader, OutputShader, GTAOShader,
 * PoissonDenoiseShader, SimplexNoise), so nothing else is fetched; each bundle carries its own Pass class,
 * which is harmless because EffectComposer only does `instanceof` against its own MaskPass. createPost() still
 * checks at runtime that a pass's Color is THREE.Color and falls back to plain rendering if it is not.
 *
 * Pipeline (quality 1 and 2):
 *   RenderPass ──► sceneRT  (MSAA 4/2, HalfFloat RGBA: linear HDR + alpha; tone mapping is NOT applied here)
 *   GTAOPass   ──► postRT   (copies sceneRT, then composites denoised AO at 1/2 or 1/4 res; own G-buffer)
 *   OutputPass ──► canvas   (ACES + sRGB, read from renderer.toneMapping / renderer.outputColorSpace)
 * Quality 0 bypasses everything with renderer.render(scene, camera).
 *
 * Integrator checklist (Engine3D / SceneRig own these; nothing here edits them):
 *  - Keep renderer.toneMapping = ACESFilmicToneMapping and outputColorSpace = SRGBColorSpace. Scene materials
 *    automatically skip tone mapping + sRGB while drawing into sceneRT; OutputPass re-reads both renderer
 *    fields every frame and applies them once, on the way to the canvas. Setting NoToneMapping would remove
 *    ACES from both paths.
 *  - Once a PostFx exists, draw every frame through post.render() (after moving the camera for shake); quality
 *    0 is the bypass. Call post.setSize(cssW, cssH, renderer.getPixelRatio()) after renderer.setSize.
 *  - Before the first frame (materials compile with the light/shadow setup):
 *      renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.VSMShadowMap;
 *    (or pass `renderer` to addContactShadows), then ball meshes castShadow = true. receiveShadow stays false
 *    on balls while the shadow light's intensity is 0 (the default: the light only feeds the backdrop).
 *    The crumbs InstancedMesh may castShadow too. The backdrop plane is configured by addContactShadows.
 *  - Ball materials are transparent: true. That does NOT drop them from AO or shadows: GTAOPass draws its
 *    G-buffer with scene.overrideMaterial (a MeshNormalMaterial), and WebGLRenderer applies the override to
 *    every opaque, transmissive AND transparent render item; WebGLShadowMap has no transparent check either.
 *    Both ignore opacity, so a fading lump keeps full AO and a full shadow until it is removed. To fade it
 *    out of both when b.fading starts: `mesh.castShadow = false; mesh.traverse((o) => o.layers.set(NO_AO_LAYER))`
 *    (layers are per object, so set children too). createPost enables NO_AO_LAYER on the main camera, so those
 *    objects still render. alphaTest / alphaMap cut-outs are likewise ignored by the AO G-buffer.
 *  - Disposal: post.dispose(), shadows.dispose().
 */

const COMPOSER_URL = "https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/postprocessing/EffectComposer.js/+esm";
const RENDER_PASS_URL = "https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/postprocessing/RenderPass.js/+esm";
const GTAO_URL = "https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/postprocessing/GTAOPass.js/+esm";
const OUTPUT_URL = "https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/postprocessing/OutputPass.js/+esm";

export type PostAddOns = { EffectComposer: any; RenderPass: any; GTAOPass: any; OutputPass: any };

let cached: Promise<PostAddOns> | null = null;

/** Loads the four r170 add-ons once (same pattern as loadThree); a failed load can be retried. */
export function loadPostAddOns(): Promise<PostAddOns> {
  if (!cached) {
    const p = Promise.all([
      import(/* @vite-ignore */ COMPOSER_URL),
      import(/* @vite-ignore */ RENDER_PASS_URL),
      import(/* @vite-ignore */ GTAO_URL),
      import(/* @vite-ignore */ OUTPUT_URL),
    ]).then(([c, r, g, o]) => ({ EffectComposer: c.EffectComposer, RenderPass: r.RenderPass, GTAOPass: g.GTAOPass, OutputPass: o.OutputPass }));
    cached = p;
    p.catch(() => { if (cached === p) cached = null; });
  }
  return cached;
}

/** Objects only on this layer still render and cast shadows but are left out of the AO G-buffer. */
export const NO_AO_LAYER = 30;

export type Quality = 0 | 1 | 2;

export type AoTuning = {
  /** World-space sampling radius. Balls are R ≈ 1.6–2.6; plate gaps / lifted shards ≈ 0.05–0.3. */
  radius: number;
  /** Max depth gap that still occludes. Must exceed the ball-silhouette → backdrop gap (≈ |planeZ|) for the contact ring. */
  thickness: number;
  /** > 1 packs the samples near the pixel: crisp crevices instead of a wide grey veil. */
  distanceExponent: number;
  distanceFallOff: number;
  /** ao = pow(ao, scale). */
  scale: number;
  /** GTAO SAMPLES define (constant across quality levels: changing it recompiles the shader). */
  samples: number;
  /** 0..1 strength of the composite. */
  intensity: number;
  /** Occlusion below this is dropped (kills faint noise on flat / faceted surfaces so nothing greys out). */
  floor: number;
  /** true: AO also darkens the transparent backdrop (premultiplied "black over"), false: only what is drawn. */
  backdrop: boolean;
  denoiseSamples: number;
  denoiseRings: number;
  denoiseRadiusExponent: number;
  lumaPhi: number;
  depthPhi: number;
  normalPhi: number;
};

export const AO_DEFAULTS: AoTuning = {
  radius: 0.9,
  thickness: 3.2,
  distanceExponent: 1.6,
  distanceFallOff: 1,
  scale: 1.1,
  samples: 16,
  intensity: 0.7,
  floor: 0.04,
  backdrop: true,
  denoiseSamples: 16,
  denoiseRings: 2,
  denoiseRadiusExponent: 1,
  lumaPhi: 10,
  depthPhi: 1,
  normalPhi: 3,
};

/** Per-level knobs. Only uniforms, render-target sizes and MSAA sample counts change, never shader defines. */
export const POST_LEVELS = {
  2: { aoScale: 0.5, msaa: 4, denoiseRadius: 6 },
  1: { aoScale: 0.25, msaa: 2, denoiseRadius: 3 },
} as const;

export type PostOpts = {
  /** CSS size and pixel ratio of the canvas; default renderer.getSize() / renderer.getPixelRatio(). */
  width?: number;
  height?: number;
  dpr?: number;
  quality?: Quality;
  ao?: Partial<AoTuning>;
  /** Pre-loaded add-ons (tests, or a caller that already awaited loadPostAddOns()). */
  addOns?: PostAddOns;
};

export type PostFx = {
  render(): void;
  setSize(w: number, h: number, dpr: number): void;
  setQuality(level: Quality): void;
  dispose(): void;
  /** true when the composer pipeline is live; false = add-ons unavailable/unsupported and render() is renderer.render. */
  ready: boolean;
  /** The passes, for tuning/debugging (e.g. gtao.output = GTAOPass.OUTPUT.AO); null when not ready. */
  passes: { composer: any; gtao: any; output: any } | null;
};

// GTAOPass's "Default" output copies the scene, then draws this over it. The stock GTAOBlendShader multiplies
// rgb by AO (DstColor × src), which cannot darken the transparent backdrop (its rgb is already 0). Here the AO is
// a premultiplied black layer: rgb' = rgb·(1−occ), a' = occ + a·(1−occ) — identical to multiplicative AO on
// opaque pixels, and a soft contact ring on the CSS gradient where the plane around a ball is occluded.
const AO_BLEND_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}`;

const AO_BLEND_FRAG = /* glsl */ `
uniform sampler2D tDiffuse;
uniform float intensity;
uniform float occFloor;
varying vec2 vUv;
void main() {
  float ao = texture2D( tDiffuse, vUv ).r;
  float occ = clamp( ( 1.0 - ao - occFloor ) / max( 1.0 - occFloor, 0.0001 ), 0.0, 1.0 ) * intensity;
  gl_FragColor = vec4( 0.0, 0.0, 0.0, occ );
}`;

// OutputShader (r170) with premultiplied alpha handled. Everything is blended over a (0,0,0,0) clear, so sceneRT
// holds premultiplied linear colour; tone-mapping/encoding that directly would brighten anti-aliased ball edges
// (rgb > alpha after sRGB → light fringe on the grey gradient). Un-premultiply, tone-map, encode, re-premultiply:
// matches what the direct renderer.render path hands the (premultipliedAlpha: true) canvas.
const PREMULT_OUTPUT_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tDiffuse;
#include <tonemapping_pars_fragment>
#include <colorspace_pars_fragment>
varying vec2 vUv;
void main() {
  vec4 src = texture2D( tDiffuse, vUv );
  float a = clamp( src.a, 0.0, 1.0 );
  gl_FragColor = vec4( a > 0.0001 ? src.rgb / a : vec3( 0.0 ), 1.0 );
  #ifdef LINEAR_TONE_MAPPING
    gl_FragColor.rgb = LinearToneMapping( gl_FragColor.rgb );
  #elif defined( REINHARD_TONE_MAPPING )
    gl_FragColor.rgb = ReinhardToneMapping( gl_FragColor.rgb );
  #elif defined( CINEON_TONE_MAPPING )
    gl_FragColor.rgb = CineonToneMapping( gl_FragColor.rgb );
  #elif defined( ACES_FILMIC_TONE_MAPPING )
    gl_FragColor.rgb = ACESFilmicToneMapping( gl_FragColor.rgb );
  #elif defined( AGX_TONE_MAPPING )
    gl_FragColor.rgb = AgXToneMapping( gl_FragColor.rgb );
  #elif defined( NEUTRAL_TONE_MAPPING )
    gl_FragColor.rgb = NeutralToneMapping( gl_FragColor.rgb );
  #endif
  #ifdef SRGB_TRANSFER
    gl_FragColor = sRGBTransferOETF( gl_FragColor );
  #endif
  gl_FragColor = vec4( gl_FragColor.rgb * a, a );
}`;

function makeAoBlend(T: ThreeNS, tune: AoTuning) {
  return new T.ShaderMaterial({
    name: "WakbbuAOBlend",
    uniforms: { tDiffuse: { value: null }, intensity: { value: tune.intensity }, occFloor: { value: tune.floor } },
    vertexShader: AO_BLEND_VERT,
    fragmentShader: AO_BLEND_FRAG,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
    blending: T.CustomBlending,
    blendEquation: T.AddEquation,
    blendSrc: T.OneFactor,
    blendDst: T.OneMinusSrcAlphaFactor,
    blendEquationAlpha: T.AddEquation,
    blendSrcAlpha: tune.backdrop ? T.OneFactor : T.ZeroFactor,
    blendDstAlpha: tune.backdrop ? T.OneMinusSrcAlphaFactor : T.OneFactor,
  });
}

/**
 * Builds the post pipeline for `renderer` / `scene` / `camera`. Never rejects: if the add-ons cannot be loaded,
 * the GPU cannot render to half-float targets, or the add-ons resolved a different three instance, it resolves
 * to a pass-through PostFx with ready = false.
 */
export async function createPost(THREE: ThreeNS, renderer: any, scene: any, camera: any, opts: PostOpts = {}): Promise<PostFx> {
  const T = THREE;
  let disposed = false;
  let level: Quality = opts.quality ?? 2;
  camera.layers.enable(NO_AO_LAYER); // objects opted out of AO must stay visible on every path

  const passThrough: PostFx = {
    ready: false,
    passes: null,
    render() { if (!disposed) renderer.render(scene, camera); },
    setSize() { /* renderer.setSize is the caller's */ },
    setQuality(l: Quality) { level = l; },
    dispose() { disposed = true; },
  };

  let A: PostAddOns;
  try {
    A = opts.addOns ?? (await loadPostAddOns());
  } catch (e) {
    console.warn("[wakbbu/post] add-ons failed to load; rendering without post-processing", e);
    return passThrough;
  }
  const ext = renderer.extensions;
  if (!(ext.has("EXT_color_buffer_float") || ext.has("EXT_color_buffer_half_float"))) {
    console.warn("[wakbbu/post] no half-float colour buffers; rendering without post-processing");
    return passThrough;
  }

  const tune: AoTuning = { ...AO_DEFAULTS, ...opts.ao };
  const shadowMap = renderer.shadowMap;
  const size = renderer.getSize(new T.Vector2());
  let dpr = renderer.getPixelRatio(); // what EffectComposer starts with
  let aoScale: number = POST_LEVELS[2].aoScale;
  let fullW = 1, fullH = 1; // composer pixel size last given to the GTAO pass

  let composer: any, gtao: any, output: any, sceneRT: any, postRT: any, aoCam: any;
  try {
    // Scene: multisampled (MSAA resolves sphere silhouettes at sub-pixel accuracy without the blur SMAA puts on
    // the painted crack lines; r170 is WebGL2-only and WebGLRenderTarget.samples resolves via blitFramebuffer),
    // HalfFloat so clearcoat highlights stay HDR until ACES, RGBA so the CSS gradient shows through.
    sceneRT = new T.WebGLRenderTarget(1, 1, { type: T.HalfFloatType, samples: POST_LEVELS[2].msaa });
    sceneRT.texture.name = "wakbbu.post.scene";
    // AO composite: single-sample, no depth (only full-screen quads land here).
    postRT = new T.WebGLRenderTarget(1, 1, { type: T.HalfFloatType, depthBuffer: false });
    postRT.texture.name = "wakbbu.post.ao";
    composer = new A.EffectComposer(renderer, postRT);
    composer.renderTarget2.dispose(); // the clone would be a second MSAA-sized buffer we never need
    composer.renderTarget2 = sceneRT;

    const renderPass = new A.RenderPass(scene, camera);
    if (!(renderPass._oldClearColor instanceof T.Color)) throw new Error("add-ons resolved a different three.js instance");

    // GTAO renders its own normal+depth G-buffer through this camera, which mirrors the main one minus NO_AO_LAYER.
    aoCam = camera.clone(false);
    aoCam.layers.disable(NO_AO_LAYER);
    gtao = new A.GTAOPass(scene, aoCam, 1, 1, undefined, {
      radius: tune.radius, distanceExponent: tune.distanceExponent, thickness: tune.thickness, scale: tune.scale,
      samples: tune.samples, distanceFallOff: tune.distanceFallOff, screenSpaceRadius: false,
    }, {
      lumaPhi: tune.lumaPhi, depthPhi: tune.depthPhi, normalPhi: tune.normalPhi, radius: POST_LEVELS[2].denoiseRadius,
      radiusExponent: tune.denoiseRadiusExponent, rings: tune.denoiseRings, samples: tune.denoiseSamples,
    });
    gtao.output = A.GTAOPass.OUTPUT.Default;
    gtao.blendIntensity = tune.intensity;
    gtao.blendMaterial.dispose();
    gtao.blendMaterial = makeAoBlend(T, tune);
    // EffectComposer.setSize/addPass hand every pass the full pixel size; keep the AO buffers at aoScale of it.
    const gtaoSetSize = gtao.setSize.bind(gtao);
    gtao.setSize = (w: number, h: number) => {
      fullW = w; fullH = h;
      gtaoSetSize(Math.max(1, Math.round(w * aoScale)), Math.max(1, Math.round(h * aoScale)));
    };

    output = new A.OutputPass();
    output.material.fragmentShader = PREMULT_OUTPUT_FRAG;
    output.material.needsUpdate = true;

    composer.addPass(renderPass);
    composer.addPass(gtao);
    composer.addPass(output);
  } catch (e) {
    console.warn("[wakbbu/post] setup failed; rendering without post-processing", e);
    try { gtao?.dispose(); output?.dispose(); composer?.dispose(); sceneRT?.dispose(); postRT?.dispose(); } catch { /* best effort */ }
    return passThrough;
  }

  const applyLevel = () => {
    if (level === 0) {
      // the composer is idle: give back the two full-resolution targets (re-allocated lazily on the way back)
      sceneRT.dispose(); postRT.dispose();
      return;
    }
    const L = POST_LEVELS[level];
    if (sceneRT.samples !== L.msaa) { sceneRT.dispose(); sceneRT.samples = L.msaa; }
    if (aoScale !== L.aoScale) { aoScale = L.aoScale; gtao.setSize(fullW, fullH); }
    gtao.updatePdMaterial({ radius: L.denoiseRadius });
  };

  const fx: PostFx = {
    ready: true,
    passes: { composer, gtao, output },
    render() {
      if (disposed) return;
      if (level === 0) { renderer.render(scene, camera); return; }
      aoCam.copy(camera, false);
      aoCam.layers.disable(NO_AO_LAYER);
      // EffectComposer ping-pongs (GTAOPass + OutputPass both needsSwap: two swaps, net zero per frame). Pin the
      // MSAA target as the scene input anyway, so the order survives a pass being disabled or a level change.
      composer.readBuffer = sceneRT;
      composer.writeBuffer = postRT;
      // Refresh shadow maps once per frame: GTAO's G-buffer render is a second renderer.render() that would
      // otherwise redraw (and, for VSM, re-blur) every shadow map.
      const auto = shadowMap.autoUpdate;
      if (auto) { shadowMap.autoUpdate = false; shadowMap.needsUpdate = true; }
      try { composer.render(0); } finally { if (auto) shadowMap.autoUpdate = true; }
    },
    setSize(w: number, h: number, d: number) {
      if (disposed) return;
      if (d !== dpr) { dpr = d; composer.setPixelRatio(d); }
      composer.setSize(w, h);
    },
    setQuality(l: Quality) {
      if (disposed || l === level) return;
      level = l;
      applyLevel();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      gtao.blendMaterial.dispose();
      gtao.gtaoMaterial.dispose(); // GTAOPass.dispose() (r170) misses these two
      gtao.dispose();
      output.dispose();
      composer.dispose(); // renderTarget1/2 = postRT/sceneRT, plus its copy pass
    },
  };
  fx.setSize(opts.width ?? size.x, opts.height ?? size.y, opts.dpr ?? dpr);
  applyLevel();
  return fx;
}

// ---------------------------------------------------------------------------------------------------------------
// Contact shadows

export type ContactShadowOpts = {
  /** z of the backdrop plane; balls live on z ≈ 0, so ≈ -(largest R + 0.2) makes them rest on it. */
  planeZ: number;
  /** World size of the play area at z = 0 (SceneRig wW × wH). */
  width: number;
  height: number;
  /** Direction from the scene TOWARD the light (normalised here). Default: upper-left, mostly from the camera. */
  dir?: [number, number, number];
  /** Shadow darkness on the backdrop (ShadowMaterial opacity). */
  opacity?: number;
  color?: number;
  /** Penumbra half-width in world units (converted to VSM blur texels). */
  softness?: number;
  /** The light's own contribution to lit materials. 0 keeps the current look: it only feeds the shadow. */
  intensity?: number;
  /** Long edge of the shadow map at quality 2 (the short edge follows the light-space aspect). */
  mapSize?: number;
  /** Highest z a caster reaches (ball front + flying crumbs). */
  casterTop?: number;
  /** Camera distance on +z, used to grow the plane so it fills the view at planeZ. */
  cameraZ?: number;
  /** If given: shadowMap.enabled = true and type = VSMShadowMap are set on it. */
  renderer?: any;
};

export type ContactShadows = {
  light: any;
  plane: any;
  setBounds(w: number, h: number): void;
  /** 2 = full map, 1/0 = half map (same world-space softness, a quarter of the blur cost). */
  setQuality(level: Quality): void;
  dispose(): void;
};

export type Vec3 = [number, number, number];
export type OrthoBounds = { left: number; right: number; bottom: number; top: number; near: number; far: number };

const norm = (v: Vec3): Vec3 => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * Tight orthographic bounds, in the view space three builds for a camera at `eye` looking at the origin with
 * `up` (Matrix4.lookAt: z = eye − target, x = up × z, y = z × x), around every corner of an axis-aligned box.
 */
export function fitShadowFrustum(eye: Vec3, up: Vec3, min: Vec3, max: Vec3): OrthoBounds {
  const z = norm(eye);
  const x = norm(cross(up, z));
  const y = cross(z, x);
  const b: OrthoBounds = { left: Infinity, right: -Infinity, bottom: Infinity, top: -Infinity, near: Infinity, far: -Infinity };
  for (let i = 0; i < 8; i++) {
    const p: Vec3 = [(i & 1 ? max : min)[0] - eye[0], (i & 2 ? max : min)[1] - eye[1], (i & 4 ? max : min)[2] - eye[2]];
    const px = dot(p, x), py = dot(p, y), d = -dot(p, z);
    if (px < b.left) b.left = px; if (px > b.right) b.right = px;
    if (py < b.bottom) b.bottom = py; if (py > b.top) b.top = py;
    if (d < b.near) b.near = d; if (d > b.far) b.far = d;
  }
  return b;
}

const LIGHT_DIST = 40;

/**
 * A shadow-only DirectionalLight plus a ShadowMaterial backdrop at planeZ. VSM, not PCFSoft: in r170
 * PCFSoftShadowMap is a fixed ~3-texel bilinear kernel (soft only if the map is coarse, which swims and blocks),
 * PCF's `radius` spreads 17 fixed taps (ghost rings when large); VSM blurs the depth moments with a separable
 * box filter `shadow.radius` texels wide (blurSamples taps per axis) and Chebyshev-tests against them, so six
 * smooth spheres get a genuinely soft, stable penumbra whose width is set in world units below.
 * VSM's weak spot, light bleeding between stacked occluders, barely applies to balls side by side on z ≈ 0.
 * VSM also draws receivers into the map (the plane), which is what makes the plane's own lookup self-consistent.
 */
export function addContactShadows(THREE: ThreeNS, scene: any, opts: ContactShadowOpts): ContactShadows {
  const T = THREE;
  const dir = norm(opts.dir ?? [-0.22, 0.34, 1]);
  const planeZ = opts.planeZ;
  const softness = opts.softness ?? 0.28;
  const baseMap = opts.mapSize ?? 2048;
  const casterTop = opts.casterTop ?? 3.2;
  const camZ = opts.cameraZ ?? 20;
  if (opts.renderer) { opts.renderer.shadowMap.enabled = true; opts.renderer.shadowMap.type = T.VSMShadowMap; }

  const light = new T.DirectionalLight(0xffffff, opts.intensity ?? 0);
  light.name = "wakbbu.contactShadowLight";
  light.castShadow = true;
  light.position.set(dir[0] * LIGHT_DIST, dir[1] * LIGHT_DIST, dir[2] * LIGHT_DIST);
  light.target.position.set(0, 0, 0);
  const sh = light.shadow;
  const up: Vec3 = Math.abs(dir[1]) > 0.98 ? [0, 0, 1] : [0, 1, 0];
  sh.camera.up.set(up[0], up[1], up[2]);
  // VSM compares against blurred depth moments: a small negative bias keeps the receiver's own (and a convex
  // ball's) surface lit, normalBias (world units, along the normal) covers grazing texels on curved glossy balls.
  sh.bias = -0.0006;
  sh.normalBias = 0.02;
  sh.blurSamples = 16; // VSM_SAMPLES define: kept constant, softness is driven by the `radius` uniform
  scene.add(light);
  scene.add(light.target);

  const geo = new T.PlaneGeometry(1, 1);
  const mat = new T.ShadowMaterial({ color: opts.color ?? 0x0b1222, opacity: opts.opacity ?? 0.22, depthWrite: false });
  const plane = new T.Mesh(geo, mat);
  plane.name = "wakbbu.contactShadowPlane";
  plane.position.set(0, 0, planeZ);
  plane.receiveShadow = true;
  plane.castShadow = false;
  plane.renderOrder = -1; // drawn first among the (transparent) balls; no depth write, so a squashed ball may poke through
  scene.add(plane);

  let mapLong = baseMap;
  let w = opts.width, h = opts.height;

  const dropMaps = () => {
    // WebGLShadowMap re-creates map/mapPass at the new size only when they are null
    sh.map?.dispose(); sh.map = null;
    sh.mapPass?.dispose(); sh.mapPass = null;
  };

  const fit = () => {
    const k = ((camZ - planeZ) / camZ) * 1.12; // fill the view at planeZ, + camera-shake margin
    plane.scale.set(w * k, h * k, 1);
    const m = 1; // crumbs can fly past the walls
    const b = fitShadowFrustum(
      [dir[0] * LIGHT_DIST, dir[1] * LIGHT_DIST, dir[2] * LIGHT_DIST], up,
      [-w / 2 - m, -h / 2 - m, planeZ - 0.2], [w / 2 + m, h / 2 + m, casterTop],
    );
    const pad = softness * 2; // the blur reads this far outside the casters
    const cam = sh.camera;
    cam.left = b.left - pad; cam.right = b.right + pad; cam.bottom = b.bottom - pad; cam.top = b.top + pad;
    cam.near = Math.max(0.05, b.near - 0.5); cam.far = b.far + 0.5;
    cam.updateProjectionMatrix();
    const ex = cam.right - cam.left, ey = cam.top - cam.bottom;
    const mx = ex >= ey ? mapLong : Math.max(256, Math.round((mapLong * ex) / ey));
    const my = ex >= ey ? Math.max(256, Math.round((mapLong * ey) / ex)) : mapLong;
    if (sh.mapSize.x !== mx || sh.mapSize.y !== my) { sh.mapSize.set(mx, my); dropMaps(); }
    sh.radius = Math.max(1, softness / (ex / mx)); // world softness → texels
  };
  fit();

  return {
    light,
    plane,
    setBounds(nw: number, nh: number) { w = nw; h = nh; fit(); },
    setQuality(level: Quality) {
      const next = level >= 2 ? baseMap : Math.max(512, baseMap >> 1);
      if (next !== mapLong) { mapLong = next; fit(); }
    },
    dispose() {
      scene.remove(plane); scene.remove(light.target); scene.remove(light);
      geo.dispose(); mat.dispose();
      sh.dispose(); sh.map = null; sh.mapPass = null;
      light.dispose();
    },
  };
}
