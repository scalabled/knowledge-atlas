import { NodeProgram } from 'sigma/rendering'
import type { ProgramInfo } from 'sigma/rendering'
import type { NodeDisplayData, RenderParams } from 'sigma/types'
import { floatColor } from 'sigma/utils'

/** Uniform state shared by the dust and orb programs; ExploreCanvas mutates it and
 * schedules a render — the slider hot path never rewrites vertex buffers. */
export interface ExploreRenderState {
  /** Row-major rows of the linear project4D map: screen = (dot(projX, raw4), dot(projY, raw4)). */
  projX: Float32Array
  projY: Float32Array
  /** Sigma's frozen normalization (from the custom bbox): (dX, dY, 1/ratio). Buffers hold
   * normalized coords, so in-shader positions must land in the same space. */
  stage: Float32Array
  /** Raw 4D centers (rawX, rawY, z, w) per dust hub, MAX_DUST_HUBS entries. */
  hubRaw: Float32Array
  /** 0..1 fade-in; also the degradation-ladder floor (0 = dust off). */
  globalAlpha: number
  /** Dust hub index to spotlight (selection figure-ground); -1 = none. */
  focusHub: number
  /** Lens contract: territories = calm mode, dust fully off. */
  lensAlpha: number
  /** Ask-focus dims dust so relevant structure pops. */
  queryDim: number
  /** Level-entry bloom for structural orbs, 0..1; reduced-motion enters at 1. */
  grow: number
}

export const MAX_DUST_HUBS = 24

export function createRenderState(): ExploreRenderState {
  const projX = new Float32Array(4)
  const projY = new Float32Array(4)
  projX[0] = 1
  projY[1] = 1
  const stage = new Float32Array(3)
  stage[2] = 1
  return { projX, projY, stage, hubRaw: new Float32Array(MAX_DUST_HUBS * 4), globalAlpha: 0, focusHub: -1, lensAlpha: 1, queryDim: 1, grow: 1 }
}

const { UNSIGNED_BYTE, FLOAT } = WebGLRenderingContext

type DustAttrs = { dustLx: number; dustLy: number; dustZ: number; dustW: number; dustHub: number; dustMaxR: number }
type OrbAttrs = { rx: number; ry: number; rz: number; rw: number; halo: number }

const DUST_VERTEX = /*glsl*/ `
precision highp float;
attribute vec2 a_local;
attribute vec2 a_zw;
attribute float a_hub;
attribute float a_maxR;
attribute float a_size;
attribute vec4 a_color;

uniform mat3 u_matrix;
uniform float u_sizeRatio;
uniform float u_pixelRatio;
uniform vec4 u_projX;
uniform vec4 u_projY;
uniform vec3 u_stage;
uniform vec4 u_hubRaw[${MAX_DUST_HUBS}];
uniform float u_globalAlpha;
uniform float u_focusHub;

varying vec4 v_color;

const float bias = 255.0 / 254.0;

void main() {
  vec4 hubRaw = u_hubRaw[int(a_hub + 0.5)];
  vec2 hubPos = vec2(dot(u_projX, hubRaw), dot(u_projY, hubRaw));
  vec4 local4 = vec4(a_local, a_zw);
  vec2 off = vec2(dot(u_projX, local4), dot(u_projY, local4));
  float len = length(off);
  if (len > a_maxR) off *= a_maxR / len;
  vec2 position = vec2(0.5, 0.5) + (hubPos + off - u_stage.xy) * u_stage.z;
  gl_Position = vec4((u_matrix * vec3(position, 1)).xy, 0, 1);
  // The quad is ~2x the core so neighboring halos overlap into nebula wash;
  // per-pixel halo energy drops to match, so stacking saturates instead of blowing out.
  float sizePx = max(a_size / u_sizeRatio * u_pixelRatio * 3.6, u_pixelRatio * 5.0);
  gl_PointSize = min(sizePx, 56.0);
  float focus = u_focusHub < -0.5 ? 1.0 : (abs(a_hub - u_focusHub) < 0.5 ? 1.25 : 0.55);
  v_color = a_color;
  v_color.a *= bias * u_globalAlpha * focus;
}
`

const DUST_FRAGMENT = /*glsl*/ `
precision highp float;
varying vec4 v_color;

void main(void) {
  #ifdef PICKING_MODE
  gl_FragColor = vec4(0.0);
  #else
  vec2 m = gl_PointCoord - vec2(0.5, 0.5);
  float d = length(m) * 2.0;
  float core = smoothstep(0.48, 0.1, d);
  float halo = exp(-d * d * 2.2) * 0.38;
  float a = clamp(core + halo, 0.0, 1.0) * v_color.a;
  gl_FragColor = vec4(v_color.rgb * a, a);
  #endif
}
`

type DustUniform = 'u_matrix' | 'u_sizeRatio' | 'u_pixelRatio' | 'u_projX' | 'u_projY' | 'u_stage' | 'u_hubRaw' | 'u_globalAlpha' | 'u_focusHub'

/** One vertex per saved item: gl.POINTS glow sprite, hub-anchored, reprojected in-shader.
 * Invisible to picking, so hubs stay clickable straight through their nebula. */
export function createDustProgram(state: ExploreRenderState) {
  return class DustProgram extends NodeProgram<DustUniform> {
    getDefinition() {
      return {
        VERTICES: 1,
        VERTEX_SHADER_SOURCE: DUST_VERTEX,
        FRAGMENT_SHADER_SOURCE: DUST_FRAGMENT,
        METHOD: WebGLRenderingContext.POINTS,
        UNIFORMS: ['u_matrix', 'u_sizeRatio', 'u_pixelRatio', 'u_projX', 'u_projY', 'u_stage', 'u_hubRaw', 'u_globalAlpha', 'u_focusHub'] as const,
        ATTRIBUTES: [
          { name: 'a_local', size: 2, type: FLOAT },
          { name: 'a_zw', size: 2, type: FLOAT },
          { name: 'a_hub', size: 1, type: FLOAT },
          { name: 'a_maxR', size: 1, type: FLOAT },
          { name: 'a_size', size: 1, type: FLOAT },
          { name: 'a_color', size: 4, type: UNSIGNED_BYTE, normalized: true },
        ],
      }
    }

    processVisibleItem(nodeIndex: number, startIndex: number, data: NodeDisplayData) {
      const attrs = data as NodeDisplayData & DustAttrs
      const array = this.array
      array[startIndex++] = attrs.dustLx
      array[startIndex++] = attrs.dustLy
      array[startIndex++] = attrs.dustZ
      array[startIndex++] = attrs.dustW
      array[startIndex++] = attrs.dustHub
      array[startIndex++] = attrs.dustMaxR
      array[startIndex++] = data.size
      array[startIndex++] = floatColor(data.color)
    }

    setUniforms(params: RenderParams, { gl, uniformLocations }: ProgramInfo) {
      gl.uniformMatrix3fv(uniformLocations.u_matrix, false, params.matrix)
      gl.uniform1f(uniformLocations.u_sizeRatio, params.sizeRatio)
      gl.uniform1f(uniformLocations.u_pixelRatio, params.pixelRatio)
      gl.uniform4fv(uniformLocations.u_projX, state.projX)
      gl.uniform4fv(uniformLocations.u_projY, state.projY)
      gl.uniform3fv(uniformLocations.u_stage, state.stage)
      gl.uniform4fv(uniformLocations.u_hubRaw, state.hubRaw)
      gl.uniform1f(uniformLocations.u_globalAlpha, state.globalAlpha * state.lensAlpha * state.queryDim)
      gl.uniform1f(uniformLocations.u_focusHub, state.focusHub)
    }
  }
}

const ORB_VERTEX = /*glsl*/ `
precision highp float;
attribute vec4 a_id;
attribute vec4 a_color;
attribute vec4 a_raw4;
attribute float a_size;
attribute float a_halo;
attribute float a_angle;

uniform mat3 u_matrix;
uniform float u_sizeRatio;
uniform float u_correctionRatio;
uniform vec4 u_projX;
uniform vec4 u_projY;
uniform vec3 u_stage;
uniform float u_grow;

varying vec4 v_color;
varying vec2 v_diffVector;
varying float v_radius;
varying float v_haloR;
varying float v_halo;

const float bias = 255.0 / 254.0;

void main() {
  vec2 raw = vec2(dot(u_projX, a_raw4), dot(u_projY, a_raw4));
  vec2 base = vec2(0.5, 0.5) + (raw - u_stage.xy) * u_stage.z;
  float haloScale = 1.0 + a_halo * 1.15;
  float size = a_size * u_correctionRatio / u_sizeRatio * 4.0 * mix(0.42, 1.0, u_grow);
  float scaled = size * haloScale;
  vec2 diffVector = scaled * vec2(cos(a_angle), sin(a_angle));
  vec2 position = base + diffVector;
  gl_Position = vec4((u_matrix * vec3(position, 1)).xy, 0, 1);
  v_diffVector = diffVector;
  v_radius = size / 2.0;
  v_haloR = scaled / 2.0;
  v_halo = a_halo;

  #ifdef PICKING_MODE
  v_color = a_id;
  #else
  v_color = a_color;
  #endif

  v_color.a *= bias;
}
`

const ORB_FRAGMENT = /*glsl*/ `
precision highp float;
varying vec4 v_color;
varying vec2 v_diffVector;
varying float v_radius;
varying float v_haloR;
varying float v_halo;

uniform float u_correctionRatio;

const vec4 transparent = vec4(0.0, 0.0, 0.0, 0.0);

void main(void) {
  float border = u_correctionRatio * 2.0;
  float dist = length(v_diffVector);

  #ifdef PICKING_MODE
  if (dist < v_radius + border)
    gl_FragColor = v_color;
  else
    gl_FragColor = transparent;

  #else
  float core = smoothstep(v_radius + border, v_radius - border, dist);
  float t = clamp((dist - v_radius) / max(border, v_haloR - v_radius), 0.0, 1.0);
  float glow = exp(-t * t * 3.1) * 0.55 * v_halo * (1.0 - t);
  float alpha = clamp(core + glow * (1.0 - core), 0.0, 1.0) * v_color.a;
  gl_FragColor = vec4(v_color.rgb * alpha, alpha);
  #endif
}
`

type OrbUniform = 'u_matrix' | 'u_sizeRatio' | 'u_correctionRatio' | 'u_projX' | 'u_projY' | 'u_stage' | 'u_grow'

/** Structural nodes (hubs, tags, items): the stock disc plus an optional luminous halo,
 * positioned in-shader from raw 4D so slider ticks are pure uniform writes. Picking
 * covers only the solid core — hit targets identical to the stock circle program. */
export function createOrbProgram(state: ExploreRenderState) {
  return class OrbProgram extends NodeProgram<OrbUniform> {
    getDefinition() {
      return {
        VERTICES: 3,
        VERTEX_SHADER_SOURCE: ORB_VERTEX,
        FRAGMENT_SHADER_SOURCE: ORB_FRAGMENT,
        METHOD: WebGLRenderingContext.TRIANGLES,
        UNIFORMS: ['u_matrix', 'u_sizeRatio', 'u_correctionRatio', 'u_projX', 'u_projY', 'u_stage', 'u_grow'] as const,
        ATTRIBUTES: [
          { name: 'a_raw4', size: 4, type: FLOAT },
          { name: 'a_size', size: 1, type: FLOAT },
          { name: 'a_halo', size: 1, type: FLOAT },
          { name: 'a_color', size: 4, type: UNSIGNED_BYTE, normalized: true },
          { name: 'a_id', size: 4, type: UNSIGNED_BYTE, normalized: true },
        ],
        CONSTANT_ATTRIBUTES: [{ name: 'a_angle', size: 1, type: FLOAT }],
        CONSTANT_DATA: [[0], [(2 * Math.PI) / 3], [(4 * Math.PI) / 3]],
      }
    }

    processVisibleItem(nodeIndex: number, startIndex: number, data: NodeDisplayData) {
      const attrs = data as NodeDisplayData & OrbAttrs
      const array = this.array
      array[startIndex++] = attrs.rx
      array[startIndex++] = attrs.ry
      array[startIndex++] = attrs.rz
      array[startIndex++] = attrs.rw
      array[startIndex++] = data.size
      array[startIndex++] = attrs.halo
      array[startIndex++] = floatColor(data.color)
      array[startIndex++] = nodeIndex
    }

    setUniforms(params: RenderParams, { gl, uniformLocations }: ProgramInfo) {
      gl.uniformMatrix3fv(uniformLocations.u_matrix, false, params.matrix)
      gl.uniform1f(uniformLocations.u_sizeRatio, params.sizeRatio)
      gl.uniform1f(uniformLocations.u_correctionRatio, params.correctionRatio)
      gl.uniform4fv(uniformLocations.u_projX, state.projX)
      gl.uniform4fv(uniformLocations.u_projY, state.projY)
      gl.uniform3fv(uniformLocations.u_stage, state.stage)
      gl.uniform1f(uniformLocations.u_grow, state.grow)
    }
  }
}
