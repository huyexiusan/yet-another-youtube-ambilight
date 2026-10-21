# Ambient Light for Videos — Radial Sampling Edition

> [中文](README.md) | English

Adds an ambient glow around a playing video: it radiates outward from the center of the frame and takes its color by walking back into the frame along the radius.

Works on **YouTube** and **Bilibili**. On Bilibili the glow sits in the page background layer (`z-index: -1`): it covers the whole page but always stays beneath text and the recommendation list, while the panels around the player are made transparent so the glow can bleed through from behind the player.

![preview](docs/final.png)

## Features

- **Radial sampling** — the pole is the center of the frame; for every pixel of the glow, the distance it extends outward is the distance it looks back inward (1:1), so the color always comes from real pixels inside the frame
- **Full-screen spread** — the glow covers the whole viewport, not just a ring around the video
- **Native gaussian blur** — done with a 2D canvas `ctx.filter: blur()`, so there is no grain from multi-tap sampling
- **No mipmaps** — everything runs in `highp`, so no color blocking or quantization steps
- **Deep Bilibili support** — panels around the player are made transparent, the player gets an adjustable corner radius, and the video border fades into the glow
- **Bilingual panel** — switch between 中文 and English at the top of the panel

## Install

Install [Tampermonkey](https://www.tampermonkey.net/) first, then pick one:

**Stable** (recommended)

> 👉 **[Install stable](https://raw.githubusercontent.com/huyexiusan/yet-another-youtube-ambilight/main/youtube-ambilight-mirror.user.js)**

**Dev** (new features land here first)

> 👉 **[Install dev build](https://raw.githubusercontent.com/huyexiusan/yet-another-youtube-ambilight/main/youtube-ambilight-dev.user.js)**

Both can be installed side by side: script name, boot flag, settings storage and canvas ids are all separate. Just don't **enable both at once** — each draws its own glow, and they add up to double brightness.

Clicking a link opens Tampermonkey's install page. Alternatively, drag the `.user.js` file into a browser window, or paste its content into a new Tampermonkey script.

## Usage

Open any page with a `<video>` element — a **◐** button appears in the bottom-right corner. Settings are stored in `localStorage`.

The *Sampling mode* option offers three modes: radial 1:1 (default), mirror fold, and edge stretch.

## Settings

### Switches

| Option | Default | Description |
|---|---|---|
| Enabled | on | Master switch |
| Edge fade | on | Blends the video border into the glow. **Bilibili only** — see *Platform differences* |

### Sliders

| Option | Default | Description |
|---|---|---|
| Corner radius | 50 | 0 = square (Bilibili native) / 50 = 12px (YouTube) / 100 = 24px. Bilibili only |
| Spread | 120% | How far the glow fades out, relative to the viewport's shorter side. 120 ≈ fills the screen |
| Blur | 32 | Maps to `blurPx = 32 × (canvas height / 512) × 1.275`, about 86px at 1080p |
| Video border fade | 30% | Fade width = `blurPx × 30%`, about 26px at 1080p. Bilibili only |
| Opacity | 100% | Overall glow strength |
| Fold ratio | 1.0× | Only used in *Mirror* mode |
| Brightness / Contrast / Saturation / Vibrance | 100 | Affect the glow only, never the video |
| Sampling resolution | 60% | Frame size uploaded to the GPU; lower is cheaper |
| Frame rate cap | 30 fps | Glow refresh rate |
| Dither | 0 | Noise against banding, off by default |

### Internal constants (not exposed)

| Option | Value | Origin |
|---|---|---|
| Fade start | 0.12 | Upstream `spreadFadeStart`, 15% |
| Fade curve | 0.85 | Upstream `spreadFadeCurve`, 35 → `16 / (35 × 0.64) ≈ 0.714` |

Both are pure look-and-feel parameters that make no visible difference when nudged, so they are fixed rather than exposed as sliders.

## Platform differences

The glow layer sits on **opposite sides** of the video on the two sites, so the same visual result needs a different implementation:

| | YouTube | Bilibili |
|---|---|---|
| Glow layer | **Above** the video (`z-index: 2147482000`) | **Below** the video (`z-index: -1`) |
| How the frame shows | Punch a hole (`destination-out` + inward feather) | **No hole** — the video covers the glow itself |
| Corner radius | Player's native 12px | Controlled by the panel slider |
| How the edge fades | Widen the hole's feather | CSS `mask`, alpha fading on all four edges |
| Why they differ | A mask would let the page **background** show through the video edge, darkening it | Here the mask reveals the blurred frame inside the glow — that is the actual blend |

## Known limitations

- Videos served cross-origin without CORS cannot be read; the script detects this and disables itself
- DRM-protected video (paid YouTube content) reads back as black
- In fullscreen the canvas is confined to the fullscreen element's subtree
- The whole viewport is rendered, which costs more than rendering a thin ring. If it stutters, lower *Sampling resolution* to 40–50% and the frame cap to 24
- Bilibili's legacy `bwp-video` player uses a closed shadow root, so frames cannot be read; the script skips it automatically
- Letterbox bars in 4:3 content are sampled as if they were part of the frame, which can leave a slightly dark halo outside the video

## Repository layout

| File | Description |
|---|---|
| `youtube-ambilight-mirror.user.js` | **Stable** build — this is the one to install |
| `youtube-ambilight-dev.user.js` | **Dev** build — new features are tested here first; run `node tools/promote.mjs` to turn it into the stable build |
| `demo-mirror-vs-clamp.html` | Live side-by-side comparison page |
| `test-video.html` | End-to-end test page (canvas → `captureStream` → `<video>`) |
| `tools/sim_compare.py` | CPU per-pixel simulation used to render comparison images |
| `tools/promote.mjs` | Dev → stable conversion (version, identifiers, update URL) |

### Workflow

```
edit youtube-ambilight-dev.user.js  →  verify in browser  →  node tools/promote.mjs
          ↑                                                          ↓
          └──────────── keep iterating ←──── youtube-ambilight-mirror.user.js
```

`promote.mjs` is purely mechanical: it strips the `-dev` suffix and rewrites `@name` / `BOOT_FLAG` / `LS_KEY` / canvas ids / update URL. In day-to-day work you only touch the dev file.

## License

MIT.

## Credits

- Sampling idea inspired by [WesselKroos/youtube-ambilight](https://github.com/WesselKroos/youtube-ambilight) (MIT)
- Bilibili layering model adapted from [tosya301/ambient-light-for-bilibili](https://github.com/tosya301/ambient-light-for-bilibili)
- First Bilibili adaptation referenced from [xiex16070-jpg/youtube-ambilight](https://github.com/xiex16070-jpg/youtube-ambilight) (Akari Akaza)
