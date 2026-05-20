"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";

const VERT = `
attribute vec2 a_position;
varying vec2 v_uv;
void main() {
  v_uv = a_position * 0.5 + 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

const SIM_FRAG = `
precision highp float;
uniform sampler2D u_state;
uniform vec2  u_res;
uniform vec2  u_autoMouse, u_autoPrev;
uniform float u_autoActive, u_autoInj;
uniform vec2  u_autoMouseB, u_autoPrevB;
uniform float u_autoActiveB, u_autoInjB;
uniform vec2  u_drop;
uniform float u_dropActive, u_dropInj;
varying vec2 v_uv;

float segDist(vec2 p, vec2 a, vec2 b) {
  vec2 ab = b - a;
  float t = clamp(dot(p - a, ab) / max(dot(ab, ab), 1e-5), 0.0, 1.0);
  return length(p - (a + ab * t));
}

float wake(vec2 fc, vec2 prev, vec2 cur, vec2 res, float r) {
  vec2 a = prev * res, b = cur * res;
  float distToLine = segDist(fc, a, b);
  float distToPoint = distance(fc, b);
  // Make tail thinner at start by using sharper falloff
  return smoothstep(r, 0.0, distToLine) * 0.65
       + smoothstep(r * 0.5, 0.0, distToPoint) * 0.35;
}

void main() {
  vec2 tx = 1.0 / u_res;
  vec2 fc = gl_FragCoord.xy, uv = fc / u_res;
  vec4 st = texture2D(u_state, uv);
  float p = st.x, v = st.y;
  float pR = texture2D(u_state, uv + vec2(tx.x, 0.0)).x;
  float pL = texture2D(u_state, uv - vec2(tx.x, 0.0)).x;
  float pU = texture2D(u_state, uv + vec2(0.0, tx.y)).x;
  float pD = texture2D(u_state, uv - vec2(0.0, tx.y)).x;
  if (fc.x < 1.0) pL = pR; if (fc.x > u_res.x - 1.0) pR = pL;
  if (fc.y < 1.0) pD = pU; if (fc.y > u_res.y - 1.0) pU = pD;

  v += (-2.0 * p + pR + pL) / 4.0 + (-2.0 * p + pU + pD) / 4.0;
  p += v;
  v -= 0.005 * p;
  v *= 0.996;
  p *= 0.997;

  p += wake(fc, u_autoPrev, u_autoMouse, u_res, 24.0) * u_autoActive * u_autoInj;
  p += wake(fc, u_autoPrevB, u_autoMouseB, u_res, 30.0) * u_autoActiveB * u_autoInjB;
  p += wake(fc, u_drop, u_drop, u_res, 18.0) * u_dropActive * u_dropInj;

  p = clamp(p, -1.2, 1.2);
  v = clamp(v, -1.2, 1.2);
  gl_FragColor = vec4(p, v, (pR - pL) * 0.5, (pU - pD) * 0.5);
}
`;

const RENDER_FRAG = `
precision highp float;
uniform sampler2D u_state;
uniform float u_time;
varying vec2 v_uv;

vec3 getColor(float t) {
  float cycle = mod(t, 12.0);
  if (cycle < 3.0) return mix(vec3(0.29, 0.56, 0.89), vec3(0.31, 0.78, 0.47), cycle * 0.333);
  if (cycle < 6.0) return mix(vec3(0.31, 0.78, 0.47), vec3(1.0, 0.42, 0.42), (cycle - 3.0) * 0.333);
  if (cycle < 9.0) return mix(vec3(1.0, 0.42, 0.42), vec3(1.0, 0.85, 0.24), (cycle - 6.0) * 0.333);
  if (cycle < 12.0) return mix(vec3(1.0, 0.85, 0.24), vec3(0.61, 0.35, 0.71), (cycle - 9.0) * 0.333);
  return vec3(0.29, 0.56, 0.89);
}

void main() {
  vec4 st = texture2D(u_state, v_uv);
  float p = st.x;
  vec2 g = st.zw;
  float gl2 = length(g), w = abs(p);

  vec3 n = normalize(vec3(-g.x * 4.2, 0.11, -g.y * 4.2));
  float s1 = pow(max(0.0, dot(n, normalize(vec3(-3.0, 10.0, 3.0)))), 48.0);
  float s2 = pow(max(0.0, dot(n, normalize(vec3(5.0, 8.0, -2.0)))), 28.0);
  float s3 = pow(max(0.0, dot(n, normalize(vec3(0.0, 12.0, 0.0)))), 18.0);

  float edge  = smoothstep(0.003, 0.09, gl2);
  float rim   = smoothstep(0.006, 0.07, gl2);
  float body  = smoothstep(0.006, 0.12, w + gl2 * 0.8);
  float crest = smoothstep(0.012, 0.16, w);
  float caus  = smoothstep(0.02, 0.10, gl2 + w * 0.3) * (1.0 - smoothstep(0.18, 0.45, w + gl2));
  float causF = pow(max(0.0, sin(gl2 * 90.0 + p * 22.0 + u_time * 2.0)), 4.0)
              * smoothstep(0.02, 0.07, gl2) * 0.22;

  vec3 dynamicColor = getColor(u_time);
  vec3 col = dynamicColor * (s1 * 0.80 + s2 * 0.32 + s3 * 0.22)
           + dynamicColor * 0.9 * (body * 0.10 + edge * 0.07 + crest * 0.05)
           + dynamicColor * 0.85 * (caus * 0.14 + causF)
           + vec3(1.0) * rim * 0.09;
  col = min(col, vec3(1.3));

  float a = clamp(s1 * 0.72 + s2 * 0.28 + s3 * 0.16
    + caus * 0.16 + causF * 0.55
    + edge * 0.10 + rim * 0.09 + crest * 0.05 + body * 0.03, 0.0, 0.62);

  gl_FragColor = vec4(col, a);
}
`;

function mkShader(gl, type, src) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, src);
  gl.compileShader(shader);

  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.error("Shader:", gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }

  return shader;
}

function mkProg(gl, vs, fs) {
  const vert = mkShader(gl, gl.VERTEX_SHADER, vs);
  const frag = mkShader(gl, gl.FRAGMENT_SHADER, fs);
  if (!vert || !frag) return null;

  const program = gl.createProgram();
  gl.attachShader(program, vert);
  gl.attachShader(program, frag);
  gl.linkProgram(program);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.error("Link:", gl.getProgramInfoLog(program));
    return null;
  }

  return program;
}

function mkFBO(gl, w, h) {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.FLOAT, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  const framebuffer = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);

  return { framebuffer, texture };
}

const R = (a, b) => a + Math.random() * (b - a);
const CL = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const C01 = (v) => Math.min(1, Math.max(0, v));
const SA = (from, to) => {
  const tau = Math.PI * 2;
  return ((((to - from) + Math.PI) % tau) + tau) % tau - Math.PI;
};

const AS = 0.08;
const AT = 0.75;
const AM = 0.1;

export default function LiquidCursorEffect() {
  const pathname = usePathname();
  const canvasRef = useRef(null);
  const animRef = useRef(null);

  const stateRef = useRef({
    ax: 0.5,
    ay: 0.5,
    pax: 0.5,
    pay: 0.5,
    atx: 0.6,
    aty: 0.4,
    adx: 1,
    ady: 0,
    aPulse: 0.3,
    aNext: 0,
    bx: 0.35,
    by: 0.65,
    pbx: 0.35,
    pby: 0.65,
    btx: 0.45,
    bty: 0.55,
    bdx: -1,
    bdy: 0,
    bPulse: 0.2,
    bNext: 0,
    dx: 0.5,
    dy: 0.5,
    dPulse: 0,
    dNext: 0,
    t: 0,
    energy: 0,
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const gl = canvas.getContext("webgl", {
      alpha: true,
      antialias: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      powerPreference: "high-performance",
    });
    if (!gl) return;

    if (!gl.getExtension("OES_texture_float") || !gl.getExtension("WEBGL_color_buffer_float")) {
      console.warn("No float FBO");
      return;
    }

    const simProgram = mkProg(gl, VERT, SIM_FRAG);
    const renderProgram = mkProg(gl, VERT, RENDER_FRAG);
    if (!simProgram || !renderProgram) return;

    const quadBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

    const simLoc = {
      position: gl.getAttribLocation(simProgram, "a_position"),
      state: gl.getUniformLocation(simProgram, "u_state"),
      res: gl.getUniformLocation(simProgram, "u_res"),
      autoMouse: gl.getUniformLocation(simProgram, "u_autoMouse"),
      autoPrev: gl.getUniformLocation(simProgram, "u_autoPrev"),
      autoActive: gl.getUniformLocation(simProgram, "u_autoActive"),
      autoInjection: gl.getUniformLocation(simProgram, "u_autoInj"),
      autoMouseB: gl.getUniformLocation(simProgram, "u_autoMouseB"),
      autoPrevB: gl.getUniformLocation(simProgram, "u_autoPrevB"),
      autoActiveB: gl.getUniformLocation(simProgram, "u_autoActiveB"),
      autoInjectionB: gl.getUniformLocation(simProgram, "u_autoInjB"),
      drop: gl.getUniformLocation(simProgram, "u_drop"),
      dropActive: gl.getUniformLocation(simProgram, "u_dropActive"),
      dropInjection: gl.getUniformLocation(simProgram, "u_dropInj"),
    };

    const renderLoc = {
      position: gl.getAttribLocation(renderProgram, "a_position"),
      state: gl.getUniformLocation(renderProgram, "u_state"),
      time: gl.getUniformLocation(renderProgram, "u_time"),
    };

    const drawQuad = (location) => {
      gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    };

    const buffers = { targets: [], idx: 0, sw: 0, sh: 0 };

    const pickT = (state, now) => {
      state.atx = R(AM, 0.45);
      state.aty = R(AM, 0.45);
      state.aPulse = Math.max(state.aPulse, R(0.1, 0.3));
      state.aNext = now + R(4000, 8000);
    };

    const pickTB = (state, now) => {
      state.btx = R(0.55, 1 - AM);
      state.bty = R(0.55, 1 - AM);
      state.bPulse = Math.max(state.bPulse, R(0.08, 0.24));
      state.bNext = now + R(5200, 9600);
    };

    const spawnD = (state, now, initial) => {
      state.dx = R(0.1, 0.9);
      state.dy = R(0.1, 0.9);
      state.dPulse = R(initial ? 0.24 : 0.14, initial ? 0.38 : 0.28);
      state.dNext = now + R(4500, 9000);
    };

    const seedA = (now) => {
      const state = stateRef.current;
      state.ax = R(AM, 0.45);
      state.ay = R(AM, 0.45);
      state.pax = state.ax;
      state.pay = state.ay;
      state.aPulse = 0.3;
      pickT(state, now);

      const angle = Math.atan2(state.aty - state.ay, state.atx - state.ax);
      state.adx = Math.cos(angle);
      state.ady = Math.sin(angle);
      spawnD(state, now, true);
      state.energy = 1;
    };

    const seedB = (now) => {
      const state = stateRef.current;
      state.bx = R(0.55, 1 - AM);
      state.by = R(0.55, 1 - AM);
      state.pbx = state.bx;
      state.pby = state.by;
      state.bPulse = 0.35;
      pickTB(state, now);

      const angle = Math.atan2(state.bty - state.by, state.btx - state.bx);
      state.bdx = Math.cos(angle);
      state.bdy = Math.sin(angle);
      state.energy = 1;
    };

    const advA = (state, now, dt) => {
      state.pax = state.ax;
      state.pay = state.ay;
      if (Math.hypot(state.atx - state.ax, state.aty - state.ay) < 0.14 || now >= state.aNext) {
        pickT(state, now);
      }

      let dx = state.atx - state.ax;
      let dy = state.aty - state.ay;
      if (state.ax < AM) dx += (AM - state.ax) * 5;
      if (state.ax > 0.45) dx -= (state.ax - 0.45) * 5;
      if (state.ay < AM) dy += (AM - state.ay) * 5;
      if (state.ay > 0.45) dy -= (state.ay - 0.45) * 5;

      const currentAngle = Math.atan2(state.ady, state.adx);
      const desiredAngle = Math.atan2(dy, dx);
      const nextAngle = currentAngle + CL(SA(currentAngle, desiredAngle), -AT * dt, AT * dt);
      state.adx = Math.cos(nextAngle);
      state.ady = Math.sin(nextAngle);
      state.ax = C01(state.ax + state.adx * AS * dt);
      state.ay = C01(state.ay + state.ady * AS * dt);

      if (state.ax <= AM || state.ax >= 0.45 || state.ay <= AM || state.ay >= 0.45) {
        state.ax = CL(state.ax, AM, 0.45);
        state.ay = CL(state.ay, AM, 0.45);
        state.atx = R(AM, 0.45);
        state.aty = R(AM, 0.45);
      }

      state.aPulse *= Math.exp(-2.5 * dt);
      return Math.hypot(state.ax - state.pax, state.ay - state.pay);
    };

    const advB = (state, now, dt) => {
      state.pbx = state.bx;
      state.pby = state.by;
      if (Math.hypot(state.btx - state.bx, state.bty - state.by) < 0.16 || now >= state.bNext) {
        pickTB(state, now);
      }

      let dx = state.btx - state.bx;
      let dy = state.bty - state.by;
      if (state.bx < 0.55) dx += (0.55 - state.bx) * 4.2;
      if (state.bx > 1 - AM) dx -= (state.bx - (1 - AM)) * 4.2;
      if (state.by < 0.55) dy += (0.55 - state.by) * 4.2;
      if (state.by > 1 - AM) dy -= (state.by - (1 - AM)) * 4.2;

      const currentAngle = Math.atan2(state.bdy, state.bdx);
      const desiredAngle = Math.atan2(dy, dx);
      const nextAngle = currentAngle + CL(SA(currentAngle, desiredAngle), -AT * 0.82 * dt, AT * 0.82 * dt);
      state.bdx = Math.cos(nextAngle);
      state.bdy = Math.sin(nextAngle);
      state.bx = C01(state.bx + state.bdx * AS * 0.72 * dt);
      state.by = C01(state.by + state.bdy * AS * 0.72 * dt);

      if (state.bx <= 0.55 || state.bx >= 1 - AM || state.by <= 0.55 || state.by >= 1 - AM) {
        state.bx = CL(state.bx, 0.55, 1 - AM);
        state.by = CL(state.by, 0.55, 1 - AM);
        state.btx = R(0.55, 1 - AM);
        state.bty = R(0.55, 1 - AM);
      }

      state.bPulse *= Math.exp(-1.5 * dt);
      return Math.hypot(state.bx - state.pbx, state.by - state.pby);
    };

    const advD = (state, now, dt) => {
      if (now >= state.dNext) spawnD(state, now, false);

      const pulse = state.dPulse;
      state.dPulse *= Math.exp(-3.8 * dt);
      return pulse;
    };

    const resize = () => {
      const dpr = Math.min(devicePixelRatio || 1, 1.5);
      const width = Math.max(1, Math.floor(canvas.clientWidth * dpr));
      const height = Math.max(1, Math.floor(canvas.clientHeight * dpr));
      if (canvas.width === width && canvas.height === height) return;

      canvas.width = width;
      canvas.height = height;
      buffers.sw = Math.max(1, Math.floor(width * 0.5));
      buffers.sh = Math.max(1, Math.floor(height * 0.5));
      buffers.targets.forEach((target) => {
        gl.deleteTexture(target.texture);
        gl.deleteFramebuffer(target.framebuffer);
      });
      buffers.targets = [mkFBO(gl, buffers.sw, buffers.sh), mkFBO(gl, buffers.sw, buffers.sh)];
      buffers.idx = 0;
    };

    let lastTime = performance.now();

    const frame = (now) => {
      animRef.current = null;
      resize();
      if (buffers.targets.length < 2) return;

      const state = stateRef.current;
      const dt = Math.min((now - lastTime) / 1000, 0.05);
      lastTime = now;
      state.t += dt;

      const autoTravel = advA(state, now, dt);
      const autoTravelB = advB(state, now, dt);
      const autoActive = Math.min(0.85, 0.15 + autoTravel * 150 + state.aPulse * 0.55);
      const autoInjection = Math.min(0.75, 0.15 + autoTravel * 35 + state.aPulse * 0.20);
      const autoActiveB = Math.min(0.95, 0.18 + autoTravelB * 160 + state.bPulse * 0.55);
      const autoInjectionB = Math.min(0.85, 0.18 + autoTravelB * 35 + state.bPulse * 0.20);
      const dropActive = advD(state, now, dt);
      const dropInjection = Math.min(0.50, dropActive * 0.8);

      state.energy = Math.max(autoActive, autoActiveB, dropActive, state.energy * Math.exp(-0.5 * dt));

      const steps = Math.min(3, Math.max(1, Math.ceil(dt / (1 / 75))));
      for (let i = 0; i < steps; i += 1) {
        const readTarget = buffers.targets[buffers.idx];
        const writeTarget = buffers.targets[1 - buffers.idx];
        gl.bindFramebuffer(gl.FRAMEBUFFER, writeTarget.framebuffer);
        gl.viewport(0, 0, buffers.sw, buffers.sh);
        gl.useProgram(simProgram);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, readTarget.texture);
        gl.uniform1i(simLoc.state, 0);
        gl.uniform2f(simLoc.res, buffers.sw, buffers.sh);
        gl.uniform2f(simLoc.autoMouse, state.ax, state.ay);
        gl.uniform2f(simLoc.autoPrev, state.pax, state.pay);
        gl.uniform1f(simLoc.autoActive, autoActive / steps);
        gl.uniform1f(simLoc.autoInjection, autoInjection);
        gl.uniform2f(simLoc.autoMouseB, state.bx, state.by);
        gl.uniform2f(simLoc.autoPrevB, state.pbx, state.pby);
        gl.uniform1f(simLoc.autoActiveB, autoActiveB / steps);
        gl.uniform1f(simLoc.autoInjectionB, autoInjectionB);
        gl.uniform2f(simLoc.drop, state.dx, state.dy);
        gl.uniform1f(simLoc.dropActive, dropActive / steps);
        gl.uniform1f(simLoc.dropInjection, dropInjection);
        drawQuad(simLoc.position);
        buffers.idx = 1 - buffers.idx;
      }

      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(renderProgram);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, buffers.targets[buffers.idx].texture);
      gl.uniform1i(renderLoc.state, 0);
      gl.uniform1f(renderLoc.time, state.t);
      drawQuad(renderLoc.position);
      gl.disable(gl.BLEND);

      if (document.visibilityState !== "hidden" && state.energy > 0.003) {
        animRef.current = requestAnimationFrame(frame);
      } else {
        state.energy = 0;
      }
    };

    const start = () => {
      if (animRef.current || document.visibilityState === "hidden") return;
      lastTime = performance.now();
      animRef.current = requestAnimationFrame(frame);
    };

    resize();
    const startTime = performance.now();
    seedA(startTime);
    seedB(startTime + 700);
    start();

    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden" && animRef.current) {
        cancelAnimationFrame(animRef.current);
        animRef.current = null;
      } else if (document.visibilityState === "visible") {
        start();
      }
    };

    window.addEventListener("resize", resize);
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      if (animRef.current) cancelAnimationFrame(animRef.current);
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      buffers.targets.forEach((target) => {
        gl.deleteTexture(target.texture);
        gl.deleteFramebuffer(target.framebuffer);
      });
      gl.deleteBuffer(quadBuffer);
      gl.deleteProgram(simProgram);
      gl.deleteProgram(renderProgram);
    };
  }, []);

  if (pathname?.includes("/editor")) return null;

  return (
    <canvas
      ref={canvasRef}
      data-liquid-effect-ignore="true"
      aria-hidden="true"
      style={{
        position: "fixed",
        inset: 0,
        width: "100%",
        height: "100%",
        zIndex: 999,
        pointerEvents: "none",
        background: "transparent",
      }}
    />
  );
}
