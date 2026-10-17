# Ambient Light for Videos — Radial Sampling Edition

> [中文](README.md) | English

> Yet another take on [youtube-ambilight](https://github.com/WesselKroos/youtube-ambilight) — the glow samples **inward along the radius** instead of stretching edge pixels, and it covers the whole screen.

Adds an ambient glow around a playing video that radiates outward from the center of the frame. Each glow pixel takes its color by walking **back into the frame along its own radius**, so the halo is built from real pixels rather than a stretched copy of the outermost row.

![preview](docs/final.png)

## How it differs from the original

| | Original (youtube-ambilight) | This script |
|---|---|---|
| Sampling | Glow canvas is `scale`× the video and filled with the upscaled frame; out-of-range UVs fall back to `CLAMP_TO_EDGE` | Polar sampling: from a glow pixel at radius `r`, walk back to `rEdge - (r - rEdge)` along the same radius |
| Coverage | A thin ring around the video (`spread` %) | The whole viewport — the glow can reach every corner of the screen |
| Blur | `filter: blur()` on a half-resolution canvas, then CSS-scaled up | `filter: blur()` at full resolution, no upscaling afterwards |
| Corners | Radial thickness is √2× at the corners → visible creases | Normalized per direction, so edge and corner sample at the same depth |
| Video edge | Hard boundary between frame and glow | Feather-erased, the frame edge dissolves into the glow |

![original vs this one](docs/compare.png)

## How it works

**1. Polar sampling, strictly 1:1**

```glsl
vec2  center = hi * 0.5;            // pole = center of the frame
vec2  v      = p - center;
float r      = length(v);           // radius
vec2  dir    = v / r;               // polar angle direction

// distance from the center to the frame border along this radius
float rEdge = min(halfSize.x / abs(dir.x), halfSize.y / abs(dir.y));

// how far you extend outward is how far you look back inward (capped at the center)
float s  = min(r - rEdge, rEdge);
float rr = rEdge - s;
vec3 col = texture(uTex, clamp(center + dir * rr, 0.0, hi)).rgb;
```

- `s = 0` (right against the frame) → samples the border pixel, so the seam is continuous;
- further out, `s` grows and the color comes from deeper inside the frame;
- sampling never leaves the frame, so no mipmap fallback is needed.

**2. Opacity uses Euclidean distance**

```glsl
vec2  over = max(-pM, pM - hiM);
float t = clamp(length(max(over, 0.0)) / uExpand, 0.0, 1.0);
```

Using `length` instead of `max(Δx, Δy)` makes the iso-lines rounded rectangles, so the four corners don't get a hard right-angle edge.

**3. Native gaussian blur**

The frame is rendered to an offscreen WebGL canvas, then blurred by a 2D canvas, exactly like the original does it — no multi-tap sampling in the shader, therefore no grain:

```js
const blurPx = settings.blur * (state.ch / 512) * 1.275;   // same formula as the original
dctx.filter = 'blur(' + blurPx + 'px)';
dctx.drawImage(state.glCanvas, 0, 0, out.width, out.height);
```

**4. Frame and glow blurred together, edge dissolved**

The shader fills the inside of the frame with the frame itself (not transparent), so the blur does not thin out the opacity at the boundary. Afterwards the frame rectangle is erased with an inward feather, exposing the real `<video>` underneath:

```js
const feather = Math.min(blurPx, Math.min(pw, ph) * 0.12);
dctx.globalCompositeOperation = 'destination-out';
dctx.filter = 'blur(' + (feather * 0.5) + 'px)';
dctx.fillRect(px + feather * 0.5, py + feather * 0.5, pw - feather, ph - feather);
```

The outer band of the video is therefore semi-transparent, blending the blurred glow with the original pixels — no layer seam, no dark rim.

![alignment check](docs/align.png)

## Install

Install [Tampermonkey](https://www.tampermonkey.net/) first, then:

> 👉 **[Install the userscript](https://raw.githubusercontent.com/huyexiusan/yet-another-youtube-ambilight/main/youtube-ambilight-mirror.user.js)**

Clicking the link opens Tampermonkey's install page directly.

Manual alternative: drag `youtube-ambilight-mirror.user.js` into a browser window, or paste its content into a new Tampermonkey script.

Open any page with a `<video>` element — a **◐** button appears in the bottom-right corner. Settings are stored in `localStorage`.

## Settings

| Option | Default | Description |
|---|---|---|
| Sampling mode | Radial 1:1 | Also offers "mirror" and "edge stretch" for comparison |
| Spread | 120% | How far the glow fades out, relative to the viewport's shorter side. 120 ≈ fills the screen |
| Blur | 32 | Maps to `blurPx = 32 × (canvas height / 512) × 1.275` |
| Opacity | 92% | Overall glow strength |
| Fade start / curve | 0.12 / 0.85 | Shape of the alpha falloff |
| Brightness / contrast / saturation / vibrance | 100 / 104 / 112 / 100 | Affect the glow only, never the video |
| Sampling resolution | 60% | Frame size uploaded to the GPU; lower is cheaper |
| Frame rate cap | 30 fps | |
| Dither | 0 | Noise used against banding, off by default |

## Known limitations

- Videos served cross-origin without CORS cannot be read; the script detects this and disables itself.
- DRM-protected video (paid YouTube content) reads back as black.
- In fullscreen the browser only renders the fullscreen element's subtree, so the canvas is confined to it.
- The whole viewport is rendered, which costs more than the original. If it stutters, lower *Sampling resolution* to 40–50% and the frame cap to 24.

## Repository layout

| File | Description |
|---|---|
| `youtube-ambilight-mirror.user.js` | The userscript itself |
| `demo-mirror-vs-clamp.html` | Browser side-by-side comparison page |
| `test-video.html` | End-to-end test page (canvas → `captureStream` → `<video>`) |
| `tools/sim_compare.py` | CPU per-pixel simulation used to render the comparison images |

## Credits

Sampling idea inspired by [WesselKroos/youtube-ambilight](https://github.com/WesselKroos/youtube-ambilight) (MIT).

## License

MIT
