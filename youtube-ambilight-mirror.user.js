// ==UserScript==
// @name         YouTube 氛围灯 · 径向反查版 (Ambilight Mirror)
// @namespace    https://github.com/huyexiusan/yet-another-youtube-ambilight
// @version      1.3.24
// @description  给视频加一圈从画面中心向外扩散的氛围光晕；颜色沿半径回到画面内部回查。支持 YouTube 与 Bilibili。
// @author       huyexiusan
// @match        *://*/*
// @run-at       document-idle
// @downloadURL  https://cdn.jsdelivr.net/gh/huyexiusan/yet-another-youtube-ambilight@latest/youtube-ambilight-mirror.user.js
// @updateURL    https://cdn.jsdelivr.net/gh/huyexiusan/yet-another-youtube-ambilight@latest/youtube-ambilight-mirror.user.js
// @grant        none
// @icon         data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA2NCA2NCI+PHJlY3Qgd2lkdGg9IjY0IiBoZWlnaHQ9IjY0IiByeD0iMTQiIGZpbGw9IiMxYTFhMWEiLz48cmVjdCB4PSIyMCIgeT0iMjAiIHdpZHRoPSIyNCIgaGVpZ2h0PSIyNCIgcng9IjMiIGZpbGw9IiNmZmYiLz48L3N2Zz4=
// ==/UserScript==

/*
 * 设计说明
 * ==================
 *
 * 复刻自 Wessel Kroos / youtube-ambilight，取色与合成方式做了几处改动。
 *
 * 原版：光晕层画布比视频大 scale 倍，铺上放大后的整幅视频，
 *        越界部分交给纹理 CLAMP_TO_EDGE，边缘像素被拉长成色带。
 *
 * 本版：以画面中心为极点做极坐标取色 ——
 *        光晕像素的极坐标是 (r, θ)，r 已超过该方向上的画面边界半径 rEdge，
 *        反查时沿同一条半径（θ 不变）回到画面内部，取 r' = rEdge - (r - rEdge) 处的像素，
 *        即「往外延展多远，就往画面里回查多远」，最多到中心。
 *
 *   另外：
 *     - 画布铺满整个视口，光晕能一路漫到屏幕边缘；
 *     - 透明度按到画面边界的欧氏距离归一化，四个角不会出现直角硬边；
 *     - 模糊不在着色器里做，而是把画面与光晕一起交给 2D canvas 的 ctx.filter='blur()'，
 *       再用「向内羽化」挖掉画面矩形，让视频边缘溶进光晕里；
 *     - 全程 highp、不用 mipmap，避免原版 mip 崩塌和 lowp 量化引起的色块与台阶。
 */

(function () {
  'use strict';

  /* =========================================================================
   * 0. 基础工具
   * ========================================================================= */
  const BOOT_FLAG = '__ambiMirrorBooted__';
  if (window[BOOT_FLAG]) return;
  window[BOOT_FLAG] = true;

  const LS_KEY = 'ambi_mirror_settings_v1';
  // 平台判断：B 站（www/player）与 YouTube 的层叠结构完全不同
  const IS_BILIBILI = /(^|\.)bilibili\.com$/i.test(location.hostname);

  // 页面背景是不是深色（B 站暗夜模式 / 影院模式）。深色底用普通混合才能"发光"，
  // 浅色底用 multiply 才不会把文字糊成一片。
  let __darkBgCache = null;
  let __darkBgTs = 0;
  function isDarkPage() {
    const now = performance.now();
    if (__darkBgCache !== null && now - __darkBgTs < 1500) return __darkBgCache;
    let dark = false;
    try {
      const bg = getComputedStyle(document.body).backgroundColor || '';
      const m = bg.match(/\d+(\.\d+)?/g);
      if (m && m.length >= 3) {
        dark = 0.299 * +m[0] + 0.587 * +m[1] + 0.114 * +m[2] < 90;
      }
    } catch (e) { /* ignore */ }
    __darkBgCache = dark;
    __darkBgTs = now;
    return dark;
  }
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const num = (v, d) => (Number.isFinite(+v) ? +v : d);

  const DEFAULTS = {
    enabled: true,
    mode: 'sweep',    // sweep = 径向反查 1:1（默认）/ mirror = 镜像 / clamp = 边缘拉伸(原版)
    expand: 120,      // 光晕扩散范围（占视口短边百分比，120 = 铺满屏幕）
    blur: 32,         // 模糊强度 0..100
    opacity: 92,      // 光晕不透明度 0..100
    lookback: 1.0,    // 镜像模式的折叠倍率
    fadeStart: 0.12,  // alpha 开始衰减的位置（0=边缘，1=最外）
    fadeCurve: 0.85,  // 衰减曲线
    brightness: 100,
    contrast: 104,
    saturation: 112,
    vibrance: 100,
    resolution: 60,   // 采样纹理分辨率（占原视频宽百分比）
    maxFps: 30,
    dither: 0,        // 抖动强度 0..100（默认关，避免颗粒感）
  };

  const settings = loadSettings();
  function loadSettings() {
    let raw = {};
    try { raw = JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch (e) { raw = {}; }
    const out = Object.assign({}, DEFAULTS, raw || {});
    for (const k of Object.keys(DEFAULTS)) {
      if (typeof DEFAULTS[k] === 'number') out[k] = num(out[k], DEFAULTS[k]);
      else if (typeof DEFAULTS[k] === 'boolean') out[k] = !!out[k];
      else out[k] = typeof out[k] === 'string' ? out[k] : DEFAULTS[k];
    }
    return out;
  }
  function saveSettings() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(settings)); } catch (e) { /* 忽略 */ }
  }

  /* =========================================================================
   * 1. 着色器
   *    —— 顶点：一个铺满画布的四边形
   *    —— 片元：把「视频之外」的像素按镜像反向查找取色，再做模糊/调色/渐变
   * ========================================================================= */
  const VERT_SRC = `#version 300 es
precision highp float;
layout(location = 0) in vec2 aPos;
out vec2 vUV;
void main() {
  // aPos ∈ [-1,1]；转成画布 uv，(0,0) 在左上角，与纹理首行一致
  vUV = vec2(aPos.x * 0.5 + 0.5, 0.5 - aPos.y * 0.5);
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

  const FRAG_SRC = `#version 300 es
precision highp float;

in vec2 vUV;
out vec4 outColor;

uniform sampler2D uTex;
uniform vec2  uRectMin;     // 视频画面左上角（画布 uv）
uniform vec2  uRectSize;    // 视频画面尺寸（画布 uv）
uniform float uExpand;      // 光晕衰减范围（以画面高度为单位）
uniform float uAspect;      // 视频宽高比 w/h
uniform float uBlur;        // 模糊半径（视频 uv 单位）
uniform float uLookback;    // 反向查找倍率
uniform float uOpacity;     // 0..1
uniform float uFadeStart;
uniform float uFadeCurve;
uniform float uBrightness;  // 1 = 100%
uniform float uContrast;
uniform float uSaturation;
uniform float uVibrance;
uniform float uDither;
uniform float uMode;        // 0 = 边缘拉伸(原版)  1 = 镜像  2 = 径向反查 1:1(默认)

const float GOLDEN = 2.39996323;   // 黄金角
const int   TAPS   = 24;          // 模糊采样点数

/* 取色核心：把光晕上的一个点，映射到视频里真正要采样的位置。
 *
 * 扩散是「以画面中心为极点、沿半径向外呈放射状」的：
 *   光晕像素 P 在以中心为原点的极坐标里是 (r, θ)，r 已经超过该方向上的画面边界半径 rEdge。
 *   反查时沿同一条半径（θ 不变）回到画面内部，取 r' = rEdge - s 处的像素。
 */
vec3 tapAt(vec2 uv) {
  // 换到「以画面高度为单位」的坐标系，横竖方向的扩散距离才可比
  vec2 hi     = vec2(uAspect, 1.0);
  vec2 p      = uv * hi;
  vec2 center = hi * 0.5;            // 画面中心 = 极点
  vec2 v      = p - center;

  float r    = length(v);
  vec2  dir  = r > 1e-6 ? v / r : vec2(0.0, 1.0);   // 这条扩散射线的方向

  // 射线与该方向上画面边界的交点距离
  vec2  halfSize = hi * 0.5;
  vec2  tt       = halfSize / max(abs(dir), vec2(1e-6));
  float rEdge    = min(tt.x, tt.y);

  // 画面内部：直接取真实像素（模糊采样点会落到画面里，这里不能拦）
  if (r <= rEdge) {
    return texture(uTex, clamp(p / hi, vec2(0.0), vec2(1.0))).rgb;
  }

  // 画面外：这条半径已经越界，距离边界 d
  float d = r - rEdge;


  if (uMode < 0.5) {
    // ① 边缘拉伸：整圈光晕都取边界上的点（原插件的行为）
    return texture(uTex, clamp(center + dir * rEdge, vec2(0.0), hi) / hi).rgb;
  }

  if (uMode < 1.5) {
    // ② 镜像：关于边界半径做反射
    float rr = abs(rEdge - (r - rEdge) * uLookback);
    return texture(uTex, clamp(center + dir * rr, vec2(0.0), hi) / hi).rgb;
  }

  // ③ 径向反查 1:1（默认）：
  //    沿「中心 → 该像素」这条半径，光晕往外延展多远，就往画面里回查多远。
  //    按方向归一化后，边和角的取色深度一致，四个角不会出现折痕。
  // 严格 1:1：往外延展多远，就往画面里回查多远（最多到画面中心）
  float s  = min(r - rEdge, rEdge);
  float rr = rEdge - s;
  return texture(uTex, clamp(center + dir * rr, vec2(0.0), hi) / hi).rgb;
}

/* 圆形模糊（黄金角螺旋采样），采样点同样走镜像反向查找 */
vec3 blurred(vec2 uv) {
  if (uBlur <= 0.00005) return tapAt(uv);

  // 逐像素角度抖动，把螺旋采样核的「花瓣」伪影打散成不可见的噪声
  // 抖动幅度限制在「一个采样间隔」以内：足够打散螺旋花纹，又不会留下明显颗粒
  float jitter = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) * (6.2831853 / float(TAPS));

  vec3 acc = tapAt(uv) * 0.12;
  float wsum = 0.12;
  for (int i = 0; i < TAPS; i++) {
    float fi = float(i) + 0.5;
    float rn = sqrt(fi / float(TAPS));
    float rad = rn * uBlur;
    float w = exp(-2.8 * rn * rn) + 1e-4;          // 近似高斯权重
    float ang = fi * GOLDEN + jitter;
    // y 方向除以宽高比，保证在屏幕上是圆的
    vec2 off = vec2(cos(ang), sin(ang) / uAspect) * rad;
    acc += tapAt(uv + off) * w;
    wsum += w;
  }
  return acc / wsum;
}

void main() {
  // 画布 uv → 视频 uv（视频矩形内是 0..1，外侧会越界，正是我们要的）
  vec2 uv = (vUV - uRectMin) / uRectSize;

  // 画面内部也填上画面本身的颜色（而不是透明）：
  // 否则高斯模糊会把边缘处的不透明度平均掉一半，合成后形成一圈暗边。
  // 真正露出视频，是在 2D 合成之后把画面矩形「挖掉」完成的。
  if (uv.x > 0.0015 && uv.x < 0.9985 && uv.y > 0.0015 && uv.y < 0.9985) {
    outColor = vec4(texture(uTex, clamp(uv, 0.0, 1.0)).rgb, 1.0);
    return;
  }

  // —— 到画面边界的「欧氏距离」归一化：0 = 贴着视频，1 = 光晕最外缘
  //    用 length 而不是 max，等值线是圆角矩形，四个角不会出现直角硬边
  vec2  hiM  = vec2(uAspect, 1.0);
  vec2  pM   = uv * hiM;
  vec2  over = max(-pM, pM - hiM);
  float distEdge = length(max(over, 0.0));
  float t = clamp(distEdge / max(uExpand, 1e-4), 0.0, 1.0);

  // —— 透明度沿距离衰减（复刻原插件 spreadFadeStart / spreadFadeCurve）
  float k = clamp((t - uFadeStart) / max(1e-4, 1.0 - uFadeStart), 0.0, 1.0);
  float alpha = uOpacity * pow(1.0 - k, uFadeCurve);
  if (alpha <= 0.001) { outColor = vec4(0.0); return; }

  // —— 取色：镜像反向查找 + 模糊
  vec3 c = tapAt(uv);   // 模糊交给 2D 层的 ctx.filter，避免多 tap 采样产生噪点

  // 亮度 / 对比度
  c = (c - 0.5) * uContrast + 0.5;
  c *= uBrightness;
  c = max(c, vec3(0.0));

  // 饱和度
  float luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(luma), c, uSaturation);

  // 自然饱和度：低饱和区域多补一点
  float mx = max(c.r, max(c.g, c.b));
  float mn = min(c.r, min(c.g, c.b));
  float sat = (mx - mn) / max(mx, 1e-4);
  c = mix(vec3(luma), c, 1.0 + (uVibrance - 1.0) * (1.0 - sat) * 1.25);

  // 抖动：抵消 8bit 输出在暗部产生的色带
  float n = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  c += (n - 0.5) * uDither;

  c = clamp(c, 0.0, 1.0);
  outColor = vec4(c * alpha, alpha);   // 预乘 alpha
}`;

  /* =========================================================================
   * 2. 渲染器
   * ========================================================================= */
  const state = {
    video: null,
    host: null,
    canvas: null,
    gl: null,
    glCanvas: null,
    dctx: null,
    dpr: 1,
    prog: null,
    u: {},
    tex: null,
    prevTex: null,      // 上一帧纹理（用于轻微的时间平滑，可选关闭）
    off: null,
    offCtx: null,
    texW: 0,
    texH: 0,
    cw: 0,
    ch: 0,
    lastRect: null,
    rafId: 0,
    ro: null,
    lastDrawTs: 0,
    lastPausedDrawTs: 0,
    lastVideoTime: -1,
    needDraw: true,
    blocked: false,     // 跨域污染等不可用状态
    started: false,
  };

  const VERTICES = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);

  function compile(gl, type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new Error('着色器编译失败: ' + log);
    }
    return sh;
  }

  function buildProgram(gl) {
    const vs = compile(gl, gl.VERTEX_SHADER, VERT_SRC);
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG_SRC);
    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error('着色器链接失败: ' + gl.getProgramInfoLog(prog));
    }
    gl.deleteShader(vs);
    gl.deleteShader(fs);

    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, VERTICES, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    const names = [
      'uTex', 'uRectMin', 'uRectSize', 'uExpand', 'uAspect', 'uBlur', 'uLookback',
      'uOpacity', 'uFadeStart', 'uFadeCurve', 'uBrightness', 'uContrast',
      'uSaturation', 'uVibrance', 'uDither', 'uMode',
    ];
    const u = {};
    for (const n of names) u[n] = gl.getUniformLocation(prog, n);

    return { prog, u };
  }

  /* ---- 找一个不会被裁剪、可以承载绝对定位画布的宿主元素 ---- */
  const isClipped = (cs) =>
    cs.overflow !== 'visible' || cs.overflowX !== 'visible' || cs.overflowY !== 'visible';

  function pickHost(video) {
    // 全屏时浏览器只渲染 fullscreenElement 的子树，画布必须放在它里面
    const fs = document.fullscreenElement;
    if (fs && fs.contains(video)) {
      if (getComputedStyle(fs).position === 'static') {
        fs.dataset.ambiOldPos = '1';
        fs.style.position = 'relative';
      }
      return fs;
    }

    // B 站（非全屏）：光晕挂到 body 上。
    // 【关键】绝不能挂进 #app —— 那是 B 站 Vue 的挂载容器，塞外部节点进去会让它的
    // patch 拿到错误节点（setAttribute is not a function / HierarchyRequestError），
    // 整页渲染崩溃，评论区、头像、推荐封面全部出不来。
    if (IS_BILIBILI) {
      return document.body;
    }

    let el = video.parentElement;
    let firstClipped = null;
    let depth = 0;
    while (el && el !== document.body && depth++ < 12) {
      let cs;
      try { cs = getComputedStyle(el); } catch (e) { break; }
      if (isClipped(cs)) { firstClipped = el; break; }
      el = el.parentElement;
    }

    // 从「被裁剪的祖先」的父级往外找，挑一个已定位的容器
    let start = firstClipped ? firstClipped.parentElement : el;
    let guard = 0;
    while (start && start !== document.documentElement && guard++ < 8) {
      let cs;
      try { cs = getComputedStyle(start); } catch (e) { break; }
      if (cs.position !== 'static' && !isClipped(cs)) return start;
      start = start.parentElement;
    }
    // YouTube 专用兜底
    return document.querySelector('ytd-player') || document.querySelector('#player') || document.body;
  }

  /**
   * B 站右侧栏的「外层透明、内层实色」是页面自己的结构：
   *   .right-container       → rgba(0,0,0,0)  外层透明
   *   .right-container-inner → rgb(9,9,11)    内层实底 ← 真正盖住光晕的是它
   * 所以这里什么都不做，让原生背景生效即可。
   * （早期版本曾给外层强行刷背景色，反而把内层实底搅乱，导致推荐栏被染色。）
   */
  function ensureSidebarOpaque() {
    if (!IS_BILIBILI) return;
    // 只清掉历史上被我们改过的内联背景，恢复页面原生表现
    document.querySelectorAll('[data-ambiOpaque="1"]').forEach((el) => {
      el.style.background = '';
      delete el.dataset.ambiOpaque;
    });
  }

  /**
   * B 站播放器周边的实心面板（视频下方发送区、右侧弹幕列表、视频选集等）
   * 会挡住背后的光晕。参考 tosya301 的 page.css，把这些面板的底色清掉，
   * 让光晕能像氛围光一样透出来。
   * 纯 CSS 注入：只改 background / box-shadow，不碰 DOM 结构，不影响 Vue。
   */
  const BILI_SURFACE_CSS = `
/* ── 播放器周边面板：背景透明化，让背后光晕透出 ── */
.bpx-player-video-area,
.bpx-player-video-perch,
.bpx-player-video-wrap,
.bpx-player-sending-area,
.bpx-player-sending-bar,
.bpx-player-sending-bar-left,
.bpx-player-sending-bar-right,
.bpx-player-video-info,
.bpx-player-sending-area::before,
.bpx-player-sending-area::after,
.bpx-player-sending-area > div,
.bpx-player-sending-area > div > div,
.bpx-player-primary-area .bpx-player-sending-area,
.bpx-player-sending-area .bui-button-blue,
.bpx-player-dm-root,
.bpx-player-dm-input,
.bpx-player-dm-switch,
.bpx-player-dm-setting,
.bpx-player-dm-wrap,
.bpx-player-dm-wrap-child,
.bpx-player-dm-btn-send,
.bpx-player-dm-management,
.bpx-player-dm-function,
.bpx-player-dm-load-status,
.bpx-player-video-inputbar,
.bpx-player-video-inputbar-wrap,
#danmukuBox,
.danmaku-wrap,
.danmaku-box,
.bpx-docker-minor,
.bpx-player-auxiliary,
.bpx-player-collapse,
.bpx-player-collapse .bui-collapse-header,
.bpx-player-collapse .bui-collapse-body,
.bpx-docker-minor > .bpx-player-viewpoint,
.bpx-docker-minor > .bpx-player-viewpoint .bpx-player-viewpoint-body,
.bpx-player-viewpoint,
.bpx-player-viewpoint-body,
/* 新版分P / 合集 UI */
.video-pod,
.video-pod__header,
.video-pod__body,
.video-pod__list,
.video-pod__item,
.video-pod .single-p,
.video-pod .multi-p,
.video-pod .page-list,
.video-pod .simple-base-item,
/* 播放器骨架屏（加载占位） */
#bilibili-player-placeholder,
#bilibili-player-placeholder-top,
#bilibili-player-placeholder-bottom,
#bilibili-player-placeholder-bottom-left,
#bilibili-player-placeholder-bottom-right {
  background: transparent !important;
  box-shadow: none !important;
}

/* ── 清掉播放器容器的圆角投影 ── */
#playerWrap,
#bilibili-player,
.bpx-docker-major,
.bpx-player-container,
.bpx-player-video-area {
  box-shadow: none !important;
}

/* ── 弹幕列表按钮 / 推荐展开收起 / 视频标签：连边框一起去掉 ── */
.bpx-player-dm-btn-footer,
.bpx-player-dm-btn-history,
.recommend-list-v1 .rec-footer,
.video-tag-container .tag-link,
.video-tag-container .show-more-btn {
  background: transparent !important;
  box-shadow: none !important;
  border-color: transparent !important;
}

/* ── 视频下方的活动提示横幅（投稿活动 / 已结束提示） ── */
.activity-m-v1,
.activity-m-v1.act-end,
.activity-m-v1 .left,
.activity-m-v1 .l-inside,
.activity-m-v1 .hinter-msg,
.activity-m-v1 .onlytip,
.left .hinter-msg,
.left .onlytip {
  background: transparent !important;
  box-shadow: none !important;
}

/* ── 评论区：发表评论的编辑器 ── */
#editor,
#editor bili-comment-rich-textarea,
#editor bili-comment-pictures-upload,
bili-comment-rich-textarea,
bili-comment-pictures-upload {
  background: transparent !important;
  box-shadow: none !important;
}

/* ── 顶栏搜索框 ── */
#nav-searchform .nav-search-content,
#nav-searchform .nav-search-input,
#nav-searchform .nav-search-btn {
  background: transparent !important;
}

/* ── 弹出面板：半透明 + 毛玻璃（原来是 rgba(20,20,20,.9) 的近实心黑） ── */
.bpx-player-ctrl-eplist-menu-wrap,
.bpx-player-ctrl-eplist-menu,
.bpx-player-dm-setting-box,
.bpx-player-dm-setting-box .bui-panel,
.bpx-player-dm-setting-left-block-add,
.bpx-player-dm-setting-left-block-sync,
.bpx-player-dm-setting-left-dmDensity {
  background: rgba(10, 10, 12, 0.18) !important;
  -webkit-backdrop-filter: blur(16px);
  backdrop-filter: blur(16px);
}
`;

  function ensureBiliSurfacesTransparent() {
    if (!IS_BILIBILI) return;
    if (document.getElementById('ambi-mirror-bili-css')) return;
    const st = document.createElement('style');
    st.id = 'ambi-mirror-bili-css';
    st.textContent = BILI_SURFACE_CSS;
    (document.head || document.documentElement).appendChild(st);
  }

  function makeCanvas(host) {
    const c = document.createElement('canvas');
    c.id = 'ambi-mirror-canvas';
    c.setAttribute('aria-hidden', 'true');
    Object.assign(c.style, {
      position: 'fixed',
      pointerEvents: 'none',
      // B 站：负层。之所以能生效，是因为 attach() 里给 body 加了 isolation:isolate，
      // 让 body 成为层叠上下文 —— 于是这个子元素画在「body 背景之上、页面内容之下」。
      // （父级没有层叠上下文时，负层会穿到背景后面，光晕直接消失。）
      // 取色逻辑本来就不用 DOM 顺序：页面内容都是 z-index:auto，天然盖在光晕上。
      zIndex: IS_BILIBILI ? '-1' : '2147482000',

      display: 'none',
      borderRadius: '0',
      margin: '0',
      padding: '0',
      border: '0',
      background: 'transparent',
    });
    // B 站：挂到 body（Vue 管不到的地方）并插在 body 的【最前面】。
    // 关键：canvas 是 z-index:0，页面内容大多是 z-index:auto，两者同一层按 DOM 顺序排列，
    // 所以必须让 canvas 排在 #app 之前，页面内容才会盖在光晕上面（否则光晕会盖住推荐栏）。
    // YouTube：直接叠在播放器最上层，画面本体在着色器里已 discard，不会挡住视频。
    if (IS_BILIBILI && host === document.body) {
      host.insertBefore(c, host.firstChild);
    } else {
      host.appendChild(c);
    }
    return c;
  }

  function computeLayout() {
    const v = state.video;
    if (!v) return null;
    const r = v.getBoundingClientRect();
    if (!r.width || !r.height) return null;

    const vw = v.videoWidth || 16;
    const vh = v.videoHeight || 9;

    // <video> 可能带 object-fit: contain 的黑边，换算出真正的画面区域
    const scale = Math.min(r.width / vw, r.height / vh);
    const dispW = vw * scale;
    const dispH = vh * scale;
    const dispX = r.left + (r.width - dispW) / 2;
    const dispY = r.top + (r.height - dispH) / 2;

    // 画布铺满整个视口：光晕才能从画面一直扩散到屏幕边缘
    const viewW = Math.max(1, window.innerWidth);
    const viewH = Math.max(1, window.innerHeight);

    return {
      vw, vh,
      dispW, dispH,
      cssW: viewW,
      cssH: viewH,
      // 画面在画布里的位置（画布 uv 比例）
      rectMinX: dispX / viewW,
      rectMinY: dispY / viewH,
      rectSizeX: dispW / viewW,
      rectSizeY: dispH / viewH,
    };
  }

  function applyLayout(L) {
    const c = state.canvas;

    // 限制总像素量，避免 4K + 高 DPR 直接把 GPU 打满
    let dpr = Math.min(window.devicePixelRatio || 1, 2);
    const MAX_PIX = 3.2e6;
    const need = L.cssW * L.cssH * dpr * dpr;
    if (need > MAX_PIX) dpr = Math.sqrt(MAX_PIX / (L.cssW * L.cssH));

    const cw = Math.max(2, Math.round(L.cssW * dpr));
    const ch = Math.max(2, Math.round(L.cssH * dpr));

    const posKey = `fixed,${Math.round(L.cssW)},${Math.round(L.cssH)},${cw}x${ch}`;
    if (state.lastRect === posKey) return;
    state.lastRect = posKey;

    // 从隐藏变显示时淡入，避免刷新后光晕「啪」地跳出来
    const wasHidden = c.style.display !== 'block';

    c.style.display = 'block';
    c.style.left = '0px';
    c.style.top = '0px';
    c.style.width = L.cssW + 'px';
    c.style.height = L.cssH + 'px';

    if (wasHidden) {
      c.style.transition = 'opacity .25s ease';
      c.style.opacity = '0';
      requestAnimationFrame(() => { c.style.opacity = '1'; });
    }

    if (c.width !== cw || c.height !== ch) {
      c.width = cw;
      c.height = ch;
    }
    if (state.glCanvas && (state.glCanvas.width !== cw || state.glCanvas.height !== ch)) {
      state.glCanvas.width = cw;
      state.glCanvas.height = ch;
    }
    state.cw = cw;
    state.ch = ch;
    state.dpr = dpr;
  }

  function ensureTexture(gl, vw, vh) {
    const targetW = Math.round(clamp(vw * settings.resolution / 100, 96, 1600));
    const targetH = Math.max(2, Math.round(targetW * vh / vw));
    if (state.tex && state.texW === targetW && state.texH === targetH) return;

    state.texW = targetW;
    state.texH = targetH;

    if (!state.tex) {
      state.tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, state.tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }
    gl.bindTexture(gl.TEXTURE_2D, state.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, targetW, targetH, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);

    // 中间绘制用的 2D 画布（先把视频缩小，再上传，省显存带宽）
    if (!state.off) state.off = document.createElement('canvas');
    state.off.width = targetW;
    state.off.height = targetH;
    state.offCtx = state.off.getContext('2d', { alpha: false, desynchronized: true });
  }

  function uploadFrame(gl) {
    const v = state.video;
    if (!v || v.readyState < 2 || !state.texW || !state.offCtx) return;
    try {
      state.offCtx.drawImage(v, 0, 0, state.texW, state.texH);
      gl.bindTexture(gl.TEXTURE_2D, state.tex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, state.off);
      state.lastVideoTime = v.currentTime;
    } catch (err) {
      // 只有真正的跨域污染才停用；视频尚未就绪之类的错误下一帧重试即可
      const msg = String((err && (err.name + ' ' + err.message)) || err);
      if (/security|tainted|cross-origin/i.test(msg)) {
        state.blocked = true;
        setStatus('该视频受跨域限制，无法读取画面');
      }
    }
  }

  function draw(skipUpload) {
    const gl = state.gl;
    const v = state.video;
    if (!gl || !v || state.blocked) return;

    const L = computeLayout();
    if (!L || L.dispW < 8 || L.dispH < 8) {
      if (state.canvas) state.canvas.style.display = 'none';
      state.needDraw = true;   // 布局还没就绪，下一轮继续尝试
      return;
    }
    applyLayout(L);

    ensureTexture(gl, L.vw, L.vh);
    // 滚动补画时画面没变，跳过帧上传，只重算布局 + 重新合成
    if (!skipUpload) uploadFrame(gl);

    if (!state.cw || !state.ch) return;
    gl.viewport(0, 0, state.cw, state.ch);
    gl.useProgram(state.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, state.tex);

    const u = state.u;
    // 光晕衰减范围（以画面高度为单位）：
    //   YouTube：用视口短边，铺满全屏；
    //   B 站：参考原版几何，只贴在播放器周围（视频短边的 18%），
    //         不做全屏扩散，否则一定会盖住标题 / 推荐列表 / 评论。
    const expandPx = Math.max(1, IS_BILIBILI
      ? Math.min(window.innerWidth, window.innerHeight) * settings.expand / 100
      : Math.min(window.innerWidth, window.innerHeight) * settings.expand / 100);
    const expandHi = expandPx / L.dispH;

    const rectMinX = L.rectMinX;
    const rectMinY = L.rectMinY;
    const rectSizeX = L.rectSizeX;
    const rectSizeY = L.rectSizeY;

    gl.uniform1i(u.uTex, 0);
    gl.uniform2f(u.uRectMin, rectMinX, rectMinY);
    gl.uniform2f(u.uRectSize, rectSizeX, rectSizeY);
    gl.uniform1f(u.uExpand, expandHi);
    gl.uniform1f(u.uAspect, L.vw / L.vh);
    gl.uniform1f(u.uBlur, (settings.blur / 100) * 0.34);
    gl.uniform1f(u.uLookback, clamp(settings.lookback, 0, 4));
    gl.uniform1f(u.uMode, settings.mode === 'clamp' ? 0 : settings.mode === 'mirror' ? 1 : 2);
    gl.uniform1f(u.uOpacity, clamp(settings.opacity / 100, 0, 1));
    gl.uniform1f(u.uFadeStart, clamp(settings.fadeStart, 0, 0.98));
    gl.uniform1f(u.uFadeCurve, clamp(settings.fadeCurve, 0.1, 4));
    gl.uniform1f(u.uBrightness, settings.brightness / 100);
    gl.uniform1f(u.uContrast, settings.contrast / 100);
    gl.uniform1f(u.uSaturation, settings.saturation / 100);
    gl.uniform1f(u.uVibrance, settings.vibrance / 100);
    gl.uniform1f(u.uDither, (settings.dither / 100) * 0.02);

    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // B 站：混合模式固定为普通叠加（不用 multiply，避免把页面压暗）；
    // 浅色页面靠收窄扩散范围来避免糊住文字，见下面的 expandPx。

    // —— 浏览器原生高斯模糊（参考原版：2D canvas + ctx.filter）
    const dctx = state.dctx;
    const out = state.canvas;
    if (dctx && out) {
      // 原版公式：blurPx = blur2 * (height / 512) * 1.275
      const blurPx = settings.blur * (state.ch / 512) * 1.275;
      dctx.filter = blurPx > 0.5 ? 'blur(' + blurPx.toFixed(2) + 'px)' : 'none';
      dctx.clearRect(0, 0, out.width, out.height);
      dctx.drawImage(state.glCanvas, 0, 0, out.width, out.height);
      dctx.filter = 'none';

      // —— 近处精细层（第一层「近锐远柔」）——
      // 全局大模糊会把画面边界那一圈的颜色和周围平均掉，导致光晕与视频"两张皮"。
      // 这里在画面周围再补一圈「小模糊」，让贴近视频的光晕保持真实颜色，
      // 向外仍是大模糊的柔和过渡。环外侧的突变由 ring 宽度 + 大模糊本身掩盖。
      if (blurPx > 3) {
        const cx0 = rectMinX * out.width;
        const cy0 = rectMinY * out.height;
        const cw = rectSizeX * out.width;
        const chh = rectSizeY * out.height;
        const ring = Math.max(20, blurPx * 1.8);
        dctx.save();
        dctx.beginPath();
        dctx.rect(cx0 - ring, cy0 - ring, cw + ring * 2, chh + ring * 2);
        dctx.rect(cx0, cy0, cw, chh);          // 内框挖掉，只画环
        dctx.clip('evenodd');
        dctx.filter = 'blur(' + Math.max(1, blurPx * 0.22).toFixed(2) + 'px)';
        dctx.drawImage(state.glCanvas, 0, 0, out.width, out.height);
        dctx.filter = 'none';
        dctx.restore();
      }

      // 把画面区域挖掉，露出上面的 <video>；这样光晕只留在画面之外，边缘不会被压暗
      const px = rectMinX * out.width;
      const py = rectMinY * out.height;
      const pw = rectSizeX * out.width;
      const ph = rectSizeY * out.height;
      // 把洞挖成「向内羽化」的：矩形先向内缩 feather/2，再模糊 feather/2，
      // 模糊后的擦除边缘正好从画面边界开始向内渐强 —— 画面外一点都不会被带走。
      // 溶解宽度 = 模糊半径，但最多吃掉画面短边的 12%，避免大模糊时画面被吞掉
      const feather = Math.max(1, Math.min(blurPx, Math.min(pw, ph) * 0.12));
      dctx.globalCompositeOperation = 'destination-out';
      dctx.filter = 'blur(' + (feather * 0.5).toFixed(2) + 'px)';
      dctx.fillStyle = '#000';
      dctx.fillRect(px + feather * 0.5, py + feather * 0.5,
                    Math.max(1, pw - feather), Math.max(1, ph - feather));
      dctx.filter = 'none';
      dctx.globalCompositeOperation = 'source-over';

      // B 站：光晕照常铺满整页，不做任何裁剪。
      // 页面内容之所以能盖住它，靠的是「body isolation + #app 透明 + 负 z-index」这套层叠，
      // 以及页面自身容器（如 .right-container-inner）的实色背景。
    }
  }

  function tick(ts) {
    state.rafId = requestAnimationFrame(tick);
    if (!state.started || !state.video) return;
    if (document.hidden) return;
    if (state.blocked) return;

    const v = state.video;
    if (!v.videoWidth) {
      // 元数据还没来（刚打开视频页），稍后重试
      state.needDraw = true;
      return;
    }

    if (v.paused || v.ended) {
      // 暂停时低频重绘：既响应尺寸/位置变化，也能在视频还没布局好时自动补画
      if (state.needDraw && ts - state.lastPausedDrawTs > 300) {
        state.needDraw = false;
        state.lastPausedDrawTs = ts;
        draw();
      }
      return;
    }

    const minGap = 1000 / clamp(settings.maxFps, 1, 60);
    if (ts - state.lastDrawTs < minGap) return;
    state.lastDrawTs = ts;
    draw();
  }

  /* =========================================================================
   * 3. 生命周期
   * ========================================================================= */
  function deinit() {
    if (state.rafId) { cancelAnimationFrame(state.rafId); state.rafId = 0; }
    if (state.ro) { try { state.ro.disconnect(); } catch (e) {} state.ro = null; }
    if (state.video && state.video.__ambiListeners) {
      const l = state.video.__ambiListeners;
      state.video.removeEventListener('loadedmetadata', l.onMeta);
      state.video.removeEventListener('resize', l.onMeta);
      state.video.removeEventListener('seeked', l.redraw);
      state.video.removeEventListener('pause', l.redraw);
      state.video.removeEventListener('play', l.redraw);
      delete state.video.__ambiListeners;
    }
    if (state.host && state.host.dataset && state.host.dataset.ambiOldPos) {
      state.host.style.position = '';
      delete state.host.dataset.ambiOldPos;
    }
    state.host = null;
    if (state.canvas) { state.canvas.remove(); state.canvas = null; }
    state.dctx = null;
    state.glCanvas = null;
    if (state.gl) { try { state.gl.getExtension('WEBGL_lose_context')?.loseContext(); } catch (e) {} }
    state.gl = null;
    state.prog = null;
    state.tex = null;
    state.off = null;
    state.offCtx = null;
    state.texW = state.texH = 0;
    state.lastRect = null;
    state.started = false;
    state.video = null;
    state.blocked = false;
  }

  function attach(video) {
    if (!video) return;
    // 只有「同一个 video 且已经成功启动」才跳过；启动失败过就允许重试
    if (state.video === video && state.started) return;
    deinit();

    state.video = video;
    state.host = pickHost(video);
    if (!state.host) return;

    if (IS_BILIBILI) {
      // 参考 tosya301/ambient-light-for-bilibili 的三件套：
      //   ① body 变成层叠上下文 → 光晕（z-index:-1）才会画在「body 背景之上、内容之下」
      //   ② #app 背景透明          → 光晕能从下面透上来
      //   ③ 页面内容 z-index:auto  → 天然盖在光晕上，不需要 DOM 顺序 / 遮罩 / 混合模式
      // 只改样式属性，绝不动 #app 的子节点 —— 否则 B 站的 Vue 渲染会崩。
      if (document.body && document.body.dataset.ambiIso !== '1') {
        document.body.dataset.ambiIso = '1';
        document.body.style.isolation = 'isolate';
      }
      const app = document.querySelector('#app');
      if (app && app.dataset.ambiBg !== '1') {
        app.dataset.ambiBg = '1';
        app.style.background = 'transparent';
      }
      ensureSidebarOpaque();
      ensureBiliSurfacesTransparent();
    }
    state.canvas = makeCanvas(state.host);
    state.dctx = state.canvas.getContext('2d', { alpha: true, desynchronized: true });

    // WebGL 渲染到一张离屏画布，再由 2D 层用 ctx.filter='blur()' 做浏览器原生高斯模糊
    // （和原版一致：不在着色器里多 tap 采样，所以完全没有颗粒噪点）
    state.glCanvas = document.createElement('canvas');

    let gl = null;
    try {
      gl = state.glCanvas.getContext('webgl2', {
        alpha: true,
        premultipliedAlpha: true,
        antialias: false,
        depth: false,
        stencil: false,
        desynchronized: true,
        preserveDrawingBuffer: true,
        powerPreference: 'high-performance',
      });
    } catch (e) { gl = null; }

    if (!gl) {
      setStatus('浏览器不支持 WebGL2，无法渲染');
      return;
    }
    state.gl = gl;

    try {
      const built = buildProgram(gl);
      state.prog = built.prog;
      state.u = built.u;
    } catch (e) {
      setStatus('着色器初始化失败：' + e.message);
      return;
    }

    state.started = true;
    state.needDraw = true;
    if (!state.rafId) state.rafId = requestAnimationFrame(tick);

    // 播放器自身尺寸变化（影院模式切换等）不一定触发 window.resize
    if (window.ResizeObserver) {
      try {
        state.ro = new ResizeObserver(() => {
          state.lastRect = null;
          state.needDraw = true;
        });
        state.ro.observe(video);
      } catch (e) { /* ignore */ }
    }

    // 视频事件：暂停、跳转、尺寸变化都要重画
    const redraw = () => { state.needDraw = true; };
    const onMeta = () => { state.lastRect = null; state.needDraw = true; };
    video.addEventListener('loadedmetadata', onMeta);
    video.addEventListener('resize', onMeta);
    video.addEventListener('seeked', redraw);
    video.addEventListener('pause', redraw);
    video.addEventListener('play', redraw);
    video.__ambiListeners = { onMeta, redraw };
  }

  /* =========================================================================
   * 4. 全局事件
   * ========================================================================= */
  let statusText = '';
  let shadowRoot = null;
  function setStatus(t) {
    statusText = t;
    if (!shadowRoot) return;
    const el = shadowRoot.getElementById('ambi-mirror-status');
    if (el) el.textContent = t;
  }

  window.addEventListener('resize', () => { state.lastRect = null; state.needDraw = true; }, { passive: true });
  // 滚动时立即重算布局；视频暂停时 tick 的重绘是 300ms 一次的，不补画会明显"慢半拍"
  let scrollRafPending = false;
  window.addEventListener('scroll', () => {
    state.lastRect = null;
    state.needDraw = true;
    if (scrollRafPending) return;
    scrollRafPending = true;
    requestAnimationFrame(() => {
      scrollRafPending = false;
      if (!state.started || !state.video) return;
      if (state.video.paused || state.video.ended) draw(true);   // 跳过帧上传，只重画位置
    });
  }, { passive: true, capture: true });
  document.addEventListener('fullscreenchange', () => {
    // 全屏时只渲染全屏元素内部，需要把画布挪进全屏容器
    const fsEl = document.fullscreenElement;
    if (fsEl && state.video && fsEl.contains(state.video)) {
      const v = state.video;
      deinit();
      setTimeout(() => attach(v), 60);
    } else if (state.video) {
      state.lastRect = null;
      state.needDraw = true;
    }
  });
  document.addEventListener('yt-navigate-finish', () => {
    state.lastRect = null;
    state.needDraw = true;
    setTimeout(bootstrap, 300);
  });
  window.addEventListener('yt-navigate-finish', () => {
    state.lastRect = null;
    state.needDraw = true;
    setTimeout(bootstrap, 300);
  });

  /* =========================================================================
   * 5. 设置面板
   * ========================================================================= */
  const PANEL_CSS = `
    :host { all: initial; }
    .wrap {
      position: fixed; right: 16px; bottom: 16px; z-index: 2147483000;
      font: 12px/1.5 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
      color: #eaeaea; user-select: none;
    }
    .fab {
      width: 40px; height: 40px; border-radius: 50%;
      background: rgba(20,20,22,.82); border: 1px solid rgba(255,255,255,.16);
      color: #fff; font-size: 17px; cursor: pointer; display: flex;
      align-items: center; justify-content: center; backdrop-filter: blur(8px);
      box-shadow: 0 4px 16px rgba(0,0,0,.35); transition: transform .15s, background .15s;
      margin-left: auto;
    }
    .fab:hover { background: rgba(40,40,44,.92); transform: scale(1.06); }
    .panel {
      display: none; width: 268px; margin-bottom: 8px; padding: 12px 14px 14px;
      background: rgba(18,18,20,.92); border: 1px solid rgba(255,255,255,.12);
      border-radius: 14px; backdrop-filter: blur(14px);
      box-shadow: 0 10px 40px rgba(0,0,0,.5);
      max-height: 72vh; overflow-y: auto;
    }
    .panel.open { display: block; }
    .panel h3 { margin: 0 0 10px; font-size: 12px; font-weight: 600; letter-spacing: .04em; color: #9fe8d0; }
    .row { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 7px 0; }
    .row label { flex: 1; color: #cfcfd4; font-size: 11.5px; }
    .row .val { width: 46px; text-align: right; color: #8fe0c4; font-variant-numeric: tabular-nums; font-size: 11px; }
    input[type=range] {
      -webkit-appearance: none; appearance: none; width: 100%; height: 3px;
      background: rgba(255,255,255,.16); border-radius: 2px; outline: none; cursor: pointer;
    }
    input[type=range]::-webkit-slider-thumb {
      -webkit-appearance: none; width: 12px; height: 12px; border-radius: 50%;
      background: #6ee7b7; box-shadow: 0 0 6px rgba(110,231,183,.6); cursor: pointer;
    }
    input[type=range]::-moz-range-thumb {
      width: 12px; height: 12px; border: none; border-radius: 50%;
      background: #6ee7b7; cursor: pointer;
    }
    .switch { display: flex; align-items: center; gap: 8px; }
    .switch input { accent-color: #34d399; width: 15px; height: 15px; cursor: pointer; }
    .hint { margin: 4px 0 8px; font-size: 10.5px; line-height: 1.45; color: #8a8a92; }
    .hint b { color: #9fe8d0; font-weight: 600; }
    .btns { display: flex; gap: 8px; margin-top: 12px; }
    .btns button {
      flex: 1; padding: 6px 0; font-size: 11px; cursor: pointer;
      background: rgba(255,255,255,.08); color: #ddd;
      border: 1px solid rgba(255,255,255,.14); border-radius: 8px;
    }
    .btns button:hover { background: rgba(255,255,255,.16); }
    .status { margin-top: 8px; font-size: 10.5px; color: #f0a8a8; min-height: 13px; }
  `;

  const CONTROLS = [
    { key: 'expand', label: '扩散范围', min: 10, max: 300, step: 5, unit: '%' },
    { key: 'blur', label: '模糊', min: 0, max: 100, step: 1, unit: '' },
    { key: 'opacity', label: '不透明度', min: 0, max: 100, step: 1, unit: '%' },
    { key: 'lookback', label: '折叠倍率（镜像）', min: 0.2, max: 3, step: 0.05, unit: '×', note: '仅「镜像」模式生效' },
    { key: 'fadeStart', label: '渐变起点', min: 0, max: 0.9, step: 0.01, unit: '' },
    { key: 'fadeCurve', label: '渐变曲线', min: 0.2, max: 3, step: 0.05, unit: '' },
    { key: 'brightness', label: '亮度', min: 0, max: 200, step: 1, unit: '%' },
    { key: 'contrast', label: '对比度', min: 40, max: 200, step: 1, unit: '%' },
    { key: 'saturation', label: '饱和度', min: 0, max: 200, step: 1, unit: '%' },
    { key: 'vibrance', label: '色彩（自然饱和度）', min: 0, max: 200, step: 1, unit: '%' },
    { key: 'resolution', label: '采样分辨率', min: 20, max: 100, step: 5, unit: '%' },
    { key: 'maxFps', label: '帧率上限', min: 10, max: 60, step: 5, unit: 'fps' },
    { key: 'dither', label: '抖动（去色带）', min: 0, max: 100, step: 1, unit: '%' },
  ];

  function createPanel() {
    if (document.getElementById('ambi-mirror-root')) return;

    const host = document.createElement('div');
    host.id = 'ambi-mirror-root';
    host.style.cssText = 'all:initial;position:fixed;inset:auto 0 0 auto;z-index:2147483000;';
    const shadow = host.attachShadow({ mode: 'open' });
    shadowRoot = shadow;

    const style = document.createElement('style');
    style.textContent = PANEL_CSS;
    shadow.appendChild(style);

    const wrap = document.createElement('div');
    wrap.className = 'wrap';

    const panel = document.createElement('div');
    panel.className = 'panel';

    const title = document.createElement('h3');
    title.textContent = '氛围灯 · 径向反查';
    panel.appendChild(title);

    // 总开关
    const swRow = document.createElement('div');
    swRow.className = 'row';
    // 注意：YouTube 开启了 Trusted Types，不能给 innerHTML 赋字符串，这里全部用 DOM API
    const swLabel = document.createElement('label');
    swLabel.textContent = '启用';
    swLabel.style.cssText = 'font-weight:600;color:#e8e8ea';
    swRow.appendChild(swLabel);
    const sw = document.createElement('div');
    sw.className = 'switch';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = settings.enabled;
    cb.addEventListener('change', () => {
      settings.enabled = cb.checked;
      saveSettings();
      if (!cb.checked) { deinit(); } else { bootstrap(true); }
    });
    sw.appendChild(cb);
    swRow.appendChild(sw);
    panel.appendChild(swRow);

    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = '以画面中心为极点沿半径反查：光晕';
    const hintStrong = document.createElement('b');
    hintStrong.textContent = '往外延展多少，就往画面里回查多少（1:1）';
    hint.appendChild(hintStrong);
    hint.appendChild(document.createTextNode('，贴着画面处取边界色。'));
    panel.appendChild(hint);

    // 采样方式
    const modeRow = document.createElement('div');
    modeRow.className = 'row';
    const modeLab = document.createElement('label');
    modeLab.textContent = '采样方式';
    const sel = document.createElement('select');
    sel.style.cssText = 'flex:1;min-width:0;background:rgba(255,255,255,.08);color:#e6e6e8;' +
      'border:1px solid rgba(255,255,255,.14);border-radius:8px;padding:4px 6px;font-size:11.5px;outline:none;';
    [['sweep', '径向反查 1:1（默认）'], ['mirror', '镜像折叠'], ['clamp', '边缘拉伸（原版）']].forEach(([v, txt]) => {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = txt;
      if (settings.mode === v) o.selected = true;
      sel.appendChild(o);
    });
    sel.addEventListener('change', () => {
      settings.mode = sel.value;
      saveSettings();
      state.needDraw = true;
    });
    modeRow.appendChild(modeLab);
    modeRow.appendChild(sel);
    panel.appendChild(modeRow);

    // 滑块
    for (const c of CONTROLS) {
      const row = document.createElement('div');
      row.className = 'row';
      const lab = document.createElement('label');
      lab.textContent = c.label;
      const val = document.createElement('span');
      val.className = 'val';
      const input = document.createElement('input');
      input.type = 'range';
      input.min = c.min;
      input.max = c.max;
      input.step = c.step;
      input.value = settings[c.key];
      input.style.width = '100%';

      const shown = () => {
        const v = settings[c.key];
        val.textContent = (c.key === 'fadeStart' || c.key === 'fadeCurve')
          ? v.toFixed(2)
          : (Number.isInteger(c.step) ? Math.round(v) : v.toFixed(2)) + c.unit;
      };
      shown();

      input.addEventListener('input', () => {
        settings[c.key] = parseFloat(input.value);
        shown();
        saveSettings();
        state.needDraw = true;
      });

      const box = document.createElement('div');
      box.style.cssText = 'flex:2;display:flex;align-items:center;gap:8px;';
      box.appendChild(input);
      box.appendChild(val);
      row.appendChild(lab);
      row.appendChild(box);
      panel.appendChild(row);

      if (c.note) {
        const n = document.createElement('div');
        n.className = 'hint';
        n.style.margin = '-2px 0 6px';
        n.textContent = c.note;
        panel.appendChild(n);
      }
    }

    // 按钮
    const btns = document.createElement('div');
    btns.className = 'btns';
    const reset = document.createElement('button');
    reset.textContent = '恢复默认';
    reset.addEventListener('click', () => {
      Object.assign(settings, DEFAULTS);
      saveSettings();
      shadow.querySelectorAll('input[type=range]').forEach((el, i) => {
        el.value = settings[CONTROLS[i].key];
        el.dispatchEvent(new Event('input'));
      });
      state.needDraw = true;
    });
    const close = document.createElement('button');
    close.textContent = '收起';
    close.addEventListener('click', () => panel.classList.remove('open'));
    btns.appendChild(reset);
    btns.appendChild(close);
    panel.appendChild(btns);

    const status = document.createElement('div');
    status.className = 'status';
    status.id = 'ambi-mirror-status';
    panel.appendChild(status);

    const fab = document.createElement('button');
    fab.className = 'fab';
    fab.title = '氛围灯设置';
    fab.textContent = '◐';
    fab.addEventListener('click', () => panel.classList.toggle('open'));

    wrap.appendChild(panel);
    wrap.appendChild(fab);
    shadow.appendChild(wrap);
    document.documentElement.appendChild(host);
  }

  /* =========================================================================
   * 6. 启动
   * ========================================================================= */
  function findVideo() {
    // B 站：优先使用 bpx 播放器里的 video；旧版 bwp-video 是 closed shadow root，读不到帧
    if (IS_BILIBILI) {
      const v = document.querySelector('.bpx-player-video-area video')
        || document.querySelector('.bpx-player-video-wrap video')
        || document.querySelector('.bpx-player-container video');
      if (v && v.tagName === 'BWP-VIDEO') return null;
      if (v) return v;
    }

    const candidates = Array.from(document.querySelectorAll('video'));
    let best = null;
    let bestArea = 0;
    for (const v of candidates) {
      const r = v.getBoundingClientRect();
      const area = r.width * r.height;
      if (area > bestArea && r.width > 100 && r.height > 60) {
        best = v;
        bestArea = area;
      }
    }
    return best || document.querySelector('video.html5-main-video') || null;
  }

  let observer = null;
  let retryTimer = 0;

  function bootstrap(force) {
    if (!settings.enabled) return;
    const v = findVideo();
    if (!v) {
      watchForVideo();
      return;
    }
    if (v === state.video && state.started && !force) return;
    attach(v);
  }

  function watchForVideo() {
    if (observer) return;
    observer = new MutationObserver(() => {
      const v = findVideo();
      if (v) {
        observer.disconnect();
        observer = null;
        attach(v);
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      if (observer) { observer.disconnect(); observer = null; }
      bootstrap(false);
    }, 4000);
  }

  function start() {
    createPanel();
    bootstrap(false);
    // YouTube 是单页应用，定期兜底检查视频元素是否被换掉
    setInterval(() => {
      if (!settings.enabled) return;
      const v = findVideo();
      if (v && v !== state.video) { attach(v); return; }
      // 页面刷新 / SPA 重排时，承载画布的宿主可能被整棵替换掉：
      // 画布已脱离文档，或者宿主已经不在文档里，就重建一次。
      if (state.started && state.canvas && (!document.contains(state.canvas) || !state.host || !document.contains(state.host))) {
        deinit();
        bootstrap(true);
      }
    }, 800);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }

  // 方便在控制台里调试
  window.__ambiMirror = { state, settings, bootstrap, attach, deinit, saveSettings };
})();
