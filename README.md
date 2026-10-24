# 视频氛围灯 · 晕染

> 中文 | [English](README.en.md)

给网页里的视频加一圈氛围光晕：以画面中心为极点向外扩散，颜色沿半径回到画面内部取样。

支持 **YouTube** 与 **Bilibili**。B 站上光晕被放在页面背景层（`z-index: -1`），铺满整页但永远在文字与推荐列表之下；播放器周边的面板会被透明化，让光晕像环境光一样从播放器背后透出来。

![效果](docs/final.png)

## 特性

- **径向取色** —— 以画面中心为极点，光晕往外延展多远，就往画面里回查多远（1:1），光晕颜色始终来自画面里的真实像素
- **全屏扩散** —— 光晕覆盖整个视口，不局限于视频周围一圈
- **浏览器原生高斯模糊** —— 用 2D canvas 的 `ctx.filter: blur()` 完成，没有多 tap 采样带来的颗粒噪点
- **不依赖 mipmap** —— 全程 `highp` 计算，不会出现色块和量化台阶
- **B 站深度适配** —— 播放器周边面板透明化、播放器圆角、视频边框渐隐，光晕能像环境光一样透出来
- **中英切换** —— 面板顶部可切换中文 / English

## 安装

先装 [Tampermonkey](https://www.tampermonkey.net/)，然后二选一：

**正式版**（推荐，稳定）

> 👉 **[安装正式版](https://raw.githubusercontent.com/huyexiusan/yet-another-video-ambilight/main/youtube-ambilight-mirror.user.js)**

**测试版**（新功能先在这里跑）

> 👉 **[安装测试版](https://raw.githubusercontent.com/huyexiusan/yet-another-video-ambilight/main/youtube-ambilight-dev.user.js)**

两版可以同时安装：脚本名、内部启动标记、设置存储、画布 id 全部隔离。但**不要同时启用**——两个都会画光晕，叠起来会亮一倍。

点开链接会自动弹出安装页。也可以把 `.user.js` 文件拖进浏览器窗口，或复制内容到 Tampermonkey「添加新脚本」。

## 使用

打开任意带 `<video>` 的页面，右下角出现 **◐** 按钮，点开调参。设置保存在 `localStorage`。

面板里的「采样方式」提供三种取色方式：径向反查 1:1（默认）、镜像折叠、边缘拉伸，可随时切换。

## 参数

### 开关

| 选项 | 默认 | 说明 |
|---|---|---|
| 启用 | 开 | 总开关 |
| 边缘渐隐 | 开 | 视频边缘溶进光晕。**仅 B 站生效**，见下方「平台差异」 |

### 滑块

| 参数 | 默认 | 说明 |
|---|---|---|
| 圆角 | 50 | 0 = 直角（B 站原生）/ 50 = 12px（YouTube）/ 100 = 24px。仅 B 站生效 |
| 扩散范围 | 120% | 光晕淡出的范围（占视口短边），120 ≈ 铺满屏幕 |
| 模糊 | 32 | 对应 `blurPx = 32 × (画布高 / 512) × 1.275`，1080p 下约 86px |
| 视频边框渐隐 | 30% | 渐隐宽度 = `blurPx × 30%`，1080p 下约 26px。仅 B 站生效 |
| 不透明度 | 100% | 光晕整体强度 |
| 折叠倍率 | 1.0× | 仅「镜像」模式下生效 |
| 亮度 / 对比度 / 饱和度 / 色彩 | 100 | 只作用于光晕，不改视频本身 |
| 采样分辨率 | 60% | 上传给 GPU 的帧尺寸，越低越省电 |
| 帧率上限 | 30 fps | 光晕刷新率 |
| 抖动 | 0 | 抗色带的噪声，默认关闭 |

### 内部常量（不在面板上）

| 参数 | 值 | 来历 |
|---|---|---|
| 渐变起点 | 0.12 | 原版 `spreadFadeStart`，15% |
| 渐变曲线 | 0.85 | 原版 `spreadFadeCurve`，35 → `16 / (35 × 0.64) ≈ 0.714` |

这两个是纯审美参数，调了看不出明显差别，所以定死不做成滑块。

## 平台差异

两个网站的光晕**层序是反的**，所以同名效果要用不同实现：

| | YouTube | Bilibili |
|---|---|---|
| 光晕层位置 | 视频**上方**（`z-index: 2147482000`） | 视频**下方**（`z-index: -1`） |
| 怎么露出画面 | 挖洞（`destination-out` + 向内羽化） | **不挖洞**，视频自己盖在上面 |
| 圆角来源 | 播放器原生 12px | 面板滑块控制 |
| 边框渐隐怎么做 | 调挖洞羽化宽度 | CSS `mask` 四边 alpha 渐隐 |
| 边框渐隐为什么不同 | 加 mask 会让视频边缘透出**页面背景**，变暗变灰 | mask 透出的是光晕里的**模糊画面**，才是融合 |

## 深浅色页面

这个插件在**深色页面**（B 站暗夜模式 / 影院模式）下效果明显更好，浅色页面上会打折扣。

原因：氛围光的本质是「在暗处发光」。深色背景上，光晕的颜色能自然地从画面边缘向外扩散，看起来像真的光；浅色背景上，光晕只能把颜色「铺」在页面上，对比度被白底冲淡，观感更接近**染色**而不是**发光**。

暗色画面还有额外问题：一层接近不透明的暗色光晕盖在浅色页面上，整页会发灰。为此加了**暗色内容保护**——取色过暗时自动收窄光晕强度（亮度低于 `0.03` 时只剩 10%）。这能让浅色模式不再「脏」，但整体观感仍不如深色模式。

如果你主要在浅色页面下用，可以试试：

- 把「不透明度」降到 60~70%
- 或者直接开 B 站的暗夜模式，效果差别很明显

## 已知限制

- 跨域且未开放 CORS 的视频读不到像素，脚本会提示并停用
- DRM 视频（YouTube 付费内容）取帧为黑屏
- 全屏时画布被限制在全屏元素内部
- 渲染区域是整个视口，开销比只渲染一圈更大。卡顿就把「采样分辨率」降到 40~50%、帧率降到 24
- B 站旧版 `bwp-video` 播放器使用 closed shadow root，无法读取帧，脚本会自动跳过
- 4:3 画面的 letterbox 黑边会被当作画面边缘取色，视频框外可能有一圈偏暗的光晕

## 文件

| 文件 | 说明 |
|---|---|
| `youtube-ambilight-mirror.user.js` | **正式版**，稳定，装这一个就够 |
| `youtube-ambilight-dev.user.js` | **测试版**，新功能先在这里验证；满意后用 `node tools/promote.mjs` 生成正式版 |
| `demo-mirror-vs-clamp.html` | 浏览器实时对比页 |
| `test-video.html` | 本地端到端测试页（canvas → `captureStream` → `<video>`） |
| `tools/sim_compare.py` | CPU 逐像素仿真，用于生成对比图 |
| `tools/promote.mjs` | 测试版 → 正式版转换（版本号、标识、自动更新地址） |

### 开发流程

```
改 youtube-ambilight-dev.user.js  →  浏览器里验证  →  node tools/promote.mjs
        ↑                                                     ↓
        └────────────── 继续迭代 ←──── youtube-ambilight-mirror.user.js
```

`promote.mjs` 只做机械转换：去掉 `-dev` 后缀、把 `@name` / `BOOT_FLAG` / `LS_KEY` / 画布 id 转成正式版、修正自动更新地址。所以平时**只需要改测试版那一个文件**。

## License

MIT。

## 致谢

- 取色思路参考 [WesselKroos/youtube-ambilight](https://github.com/WesselKroos/youtube-ambilight)（MIT）
- B 站层叠模型参考 [tosya301/ambient-light-for-bilibili](https://github.com/tosya301/ambient-light-for-bilibili)
- B 站适配的第一版参考 [xiex16070-jpg/youtube-ambilight](https://github.com/xiex16070-jpg/youtube-ambilight)（Akari Akaza）
