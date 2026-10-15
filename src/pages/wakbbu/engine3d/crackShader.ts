import type { ThreeNS } from "./three";
import { DIST_SCALE } from "./plateField";
import { GAP_SCALE, MAX_PLATES } from "./shell";
import * as C from "../engine/constants";

/**
 * Cracks drawn by the ball's own MeshPhysicalMaterial (injected with onBeforeCompile), from:
 *   uFieldId    RG8, nearest  — owner plate, neighbour plate across the closest border
 *   uFieldDist  R8, linear    — distance to that border (field texels × DIST_SCALE)
 *   uPlateState RGBA8 64×1    — per plate: hairline, gap half-width, tilt, open
 *   uHole       R8, linear    — peeled-chip holes (0.5 = hole edge)
 * Every width is compared against fwidth() of the interpolated distance, so edges are anti-aliased
 * at any zoom: no stair-steps, and hairlines never thinner than ~1 px.
 *
 * Every ball and every peeled chip uses this same function object, so three gives them one shared
 * program (the cache key is the function source): a chip appearing mid-drag never compiles a shader.
 */

export type CrackUniforms = Record<string, { value: unknown }>;

/** 1×1 placeholders so the sampler uniforms exist from the first frame (no recompile later). */
export function makeDummyTextures(T: ThreeNS) {
  const id = new T.DataTexture(new Uint8Array([0, 0]), 1, 1, T.RGFormat, T.UnsignedByteType);
  const dist = new T.DataTexture(new Uint8Array([255]), 1, 1, T.RedFormat, T.UnsignedByteType);
  const state = new T.DataTexture(new Uint8Array(MAX_PLATES * 4), MAX_PLATES, 1, T.RGBAFormat, T.UnsignedByteType);
  const hole = new T.DataTexture(new Uint8Array([0]), 1, 1, T.RedFormat, T.UnsignedByteType);
  for (const t of [id, dist, state, hole]) { t.needsUpdate = true; }
  return { id, dist, state, hole };
}

export function makeCrackUniforms(T: ThreeNS, dummies: ReturnType<typeof makeDummyTextures>, variant: C.ShellVariant): CrackUniforms {
  const light = variant.light;
  return {
    uCrackOn: { value: 0 },
    uFieldId: { value: dummies.id },
    uFieldDist: { value: dummies.dist },
    uPlateState: { value: dummies.state },
    uHole: { value: dummies.hole },
    uClay: { value: new T.Color(variant.core) },
    uMudColor: { value: new T.Color(variant.base) },
    uMud: { value: 0 },
    // paraffin whitens where it breaks; on milk/steel shells a cool grey reads better than white
    uEdge: { value: new T.Color(light ? "#7d8598" : C.FRACTURE) },
    uHair: { value: new T.Color(light ? "#6f778a" : "#e9edf6") },
    uTexelWorld: { value: 0.01 },
    uOoze: { value: 0 },
    uGroove: { value: 1 },
  };
}

const PARS = /* glsl */ `
uniform float uCrackOn;
uniform sampler2D uFieldId;
uniform sampler2D uFieldDist;
uniform sampler2D uPlateState;
uniform sampler2D uHole;
uniform vec3 uClay;
uniform vec3 uMudColor;
uniform float uMud;
uniform vec3 uEdge;
uniform vec3 uHair;
uniform float uTexelWorld;
uniform float uOoze;
uniform float uGroove;
float crGap = 0.0;   // 1 inside an open crack (clay shows)
float crEdge = 0.0;  // the whitened fracture edge of the wax along an open crack
float crHeight = 0.0; // groove depth (field texels, negative = into the ball) for the lighting
// height -> normal: n' = normalize(n - grad h), with grad h taken from screen derivatives
vec3 crPerturb(vec3 surfPos, vec3 n, float h) {
  vec3 px = dFdx(surfPos), py = dFdy(surfPos);
  float lx = max(length(px), 1e-6), ly = max(length(py), 1e-6);
  vec3 g = (dFdx(h) / lx) * (px / lx) + (dFdy(h) / ly) * (py / ly);
  g -= n * dot(g, n);
  return normalize(n - g);
}
`;

const MAIN = /* glsl */ `
if (uCrackOn > 0.5) {
  vec2 crIds = texture2D(uFieldId, vMapUv).rg * 255.0;
  vec4 crA = texelFetch(uPlateState, ivec2(int(crIds.x + 0.5), 0), 0);
  vec4 crB = texelFetch(uPlateState, ivec2(int(crIds.y + 0.5), 0), 0);
  float crD = texture2D(uFieldDist, vMapUv).r * (255.0 / ${DIST_SCALE.toFixed(1)});
  float crAA = max(fwidth(crD) * 0.8, 0.03);
  // a crack opens symmetrically about the border if either side is cracked
  float crOpen = max(crA.a, crB.a);
  float crW = max(crA.a * crA.g, crB.a * crB.g) * (255.0 / ${GAP_SCALE.toFixed(1)});
  float crIn = crOpen * (1.0 - smoothstep(crW - crAA, crW + crAA, crD));
  // the wax has thickness: between the clay and the plate surface a wall of broken wax shows,
  // a hairline-thin lip on a fresh crack, a visible step once the crack is wide open
  float crEw = 0.4 + 0.3 * crW;
  float crE = crOpen * (1.0 - smoothstep(crW + crEw - crAA, crW + crEw + crAA, crD)) * (1.0 - crIn);
  // hairline: before the shell opens, a fine line along the plate border (never thinner than ~1 px)
  float crHair = max(crA.r, crB.r) * (1.0 - crOpen);
  float crHw = max(0.42, crAA * 1.1);
  crHair *= (1.0 - smoothstep(crHw - crAA, crHw + crAA, crD)) * clamp(0.7 / max(crAA * 2.0, 0.35), 0.35, 1.0);
  // peeled-chip holes (soft-edged mask)
  float crHv = texture2D(uHole, vMapUv).r;
  float crHaa = max(fwidth(crHv), 0.004);
  float crInHole = smoothstep(0.5 - crHaa, 0.5 + crHaa, crHv);
  float crHoleRim = smoothstep(0.34 - crHaa, 0.34 + crHaa, crHv) * (1.0 - crInHole);
  crGap = max(crIn, crInHole);
  crEdge = max(crE, crHoleRim);
  // height: a plate stays flat right up to its edge, then a steep wall drops to the clay floor
  // (a slab with thickness, not foil bending into the crack)
  crHeight = -crOpen * (1.0 - smoothstep(crW, crW + crEw, crD)) * (0.6 + 0.3 * crW)
           - crHair * 0.45 - crInHole * 1.2;
  // cracked plates tilt only a little: they sit on the clay, they do not curl up
  float crTilt = (crA.b - 0.5) * 2.0 * crA.a;
  diffuseColor.rgb *= 1.0 + crTilt * 0.05;
  vec3 crClay = mix(uClay, uMudColor, uMud);
  float crT = crW > 0.0 ? clamp(crD / max(crW, 1e-3), 0.0, 1.0) : 1.0;
  // a fresh crack is a dark slit; a wide-open one shows the coloured core itself, shadowed under the wax wall
  vec3 crNarrow = crClay * mix(0.13, 0.46 + 0.22 * uOoze, pow(crT, 1.6));
  vec3 crWideCol = crClay * (0.95 - 0.5 * smoothstep(0.55, 1.0, crT));
  vec3 crGapCol = mix(crNarrow, crWideCol, smoothstep(1.6, 4.0, crW));
  crGapCol = mix(crGapCol, crClay * (0.62 + 0.2 * uOoze), crInHole);
  // the wall: the wax's own colour, a little paler at the top (a cut through paraffin), in shadow where it meets the clay
  float crWallT = clamp((crD - crW) / max(crEw, 1e-3), 0.0, 1.0);
  vec3 crWallCol = mix(diffuseColor.rgb * 0.45, mix(diffuseColor.rgb * 0.9, uEdge, 0.3), crWallT);
  diffuseColor.rgb = mix(diffuseColor.rgb, uHair, crHair * 0.6);
  diffuseColor.rgb = mix(diffuseColor.rgb, crWallCol, crEdge);
  diffuseColor.rgb = mix(diffuseColor.rgb, crGapCol, crGap);
}
`;

/** onBeforeCompile for the ball and chip materials. `this` is the material; its uniforms live on `crackUniforms`. */
export function crackOnBeforeCompile(this: { crackUniforms?: CrackUniforms }, shader: { uniforms: Record<string, unknown>; fragmentShader: string }) {
  if (this.crackUniforms) Object.assign(shader.uniforms, this.crackUniforms);
  let fs = shader.fragmentShader;
  fs = fs.replace("#include <common>", "#include <common>\n" + PARS);
  fs = fs.replace("#include <map_fragment>", "#include <map_fragment>\n" + MAIN);
  fs = fs.replace("#include <roughnessmap_fragment>", "#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.6, crEdge);\nroughnessFactor = mix(roughnessFactor, 0.94, crGap);");
  fs = fs.replace("#include <metalnessmap_fragment>", "#include <metalnessmap_fragment>\nmetalnessFactor *= 1.0 - max(crGap, crEdge * 0.7);");
  fs = fs.replace("#include <normal_fragment_maps>", "#include <normal_fragment_maps>\nif (uCrackOn > 0.5) normal = crPerturb(-vViewPosition, normal, crHeight * uTexelWorld * uGroove);");
  fs = fs.replace(
    "#include <clearcoat_normal_fragment_maps>",
    "#include <clearcoat_normal_fragment_maps>\n#ifdef USE_CLEARCOAT\nif (uCrackOn > 0.5) clearcoatNormal = crPerturb(-vViewPosition, clearcoatNormal, crHeight * uTexelWorld * uGroove);\n#endif",
  );
  fs = fs.replace(
    "#include <lights_physical_fragment>",
    "#include <lights_physical_fragment>\n#ifdef USE_CLEARCOAT\nmaterial.clearcoat *= (1.0 - crGap) * (1.0 - 0.6 * crEdge);\n#endif\n#ifdef USE_SHEEN\nmaterial.sheenColor *= 1.0 - crGap;\n#endif",
  );
  shader.fragmentShader = fs;
}
