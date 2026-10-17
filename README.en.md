# Ambient Light for Videos — Radial Sampling Edition

> [中文](README.md) | English

Adds an ambient glow around a playing video: it radiates outward from the center of the frame, samples its color by walking back into the frame along the radius, and reaches every corner of the screen.

![preview](docs/final.png)

## Features

- **Radial sampling** — the pole is the center of the frame; for every pixel of the glow, the distance it extends outward is the distance it looks back inward (1:1), so the color always comes from real pixels inside the frame
- **Full-screen spread** — the glow covers the whole viewport, not just a ring around the video
- **Native gaussian blur** — done with a 2D canvas `ctx.filter: blur()`, so there is no grain from multi-tap sampling
- **Dissolved edges** — frame and glow are blurred together, then the frame is feathered inward so the video edge melts into the glow
- **No mipmaps** — everything runs in `highp`, so no color blocking or quantization steps

## Install

Install [Tampermonkey](https://www.tampermonkey.net/) first, then:

> 👉 **[Install the userscript](https://raw.githubusercontent.com/huyexiusan/yet-another-youtube-ambilight/main/youtube-ambilight-mirror.user.js)**

Clicking the link opens Tampermonkey's install page. Alternatively, drag `youtube-ambilight-mirror.user.js` into a browser window, or paste its content into a new Tampermonkey script.

## Usage

Open any page with a `<video>` element — a **◐** button appears in the bottom-right corner. Settings are stored in `localStorage`.

The *Sampling mode* option offers three modes: radial 1:1 (default), mirror, and edge stretch.

## Settings

| Option | Default | Description |
|---|---|---|
| Sampling mode | Radial 1:1 | Radial / mirror / edge stretch |
| Spread | 120% | How far the glow fades out, relative to the viewport's shorter side. 120 ≈ fills the screen |
| Blur | 32 | Maps to `blurPx = 32 × (canvas height / 512) × 1.275` |
| Opacity | 92% | Overall glow strength |
| Fade start / curve | 0.12 / 0.85 | Shape of the alpha falloff |
| Brightness / contrast / saturation / vibrance | 100 / 104 / 112 / 100 | Affect the glow only, never the video |
| Sampling resolution | 60% | Frame size uploaded to the GPU; lower is cheaper |
| Frame rate cap | 30 fps | |
| Dither | 0 | Noise against banding, off by default |

## Known limitations

- Videos served cross-origin without CORS cannot be read; the script detects this and disables itself
- DRM-protected video (paid YouTube content) reads back as black
- In fullscreen the canvas is confined to the fullscreen element's subtree
- The whole viewport is rendered, which costs more than rendering a thin ring. If it stutters, lower *Sampling resolution* to 40–50% and the frame cap to 24

## Repository layout

| File | Description |
|---|---|
| `youtube-ambilight-mirror.user.js` | The userscript itself |
| `demo-mirror-vs-clamp.html` | Live side-by-side comparison page |
| `test-video.html` | End-to-end test page (canvas → `captureStream` → `<video>`) |
| `tools/sim_compare.py` | CPU per-pixel simulation used to render comparison images |

## License

MIT.

Sampling idea inspired by [WesselKroos/youtube-ambilight](https://github.com/WesselKroos/youtube-ambilight) (MIT).
