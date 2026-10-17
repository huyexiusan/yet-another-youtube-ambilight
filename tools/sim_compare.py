# -*- coding: utf-8 -*-
"""
在 CPU 上逐像素复刻 YouTube Ambilight 的外扩取色逻辑，对比两种采样方式：

  A. CLAMP_TO_EDGE      —— 原插件做法：UV 越界后被纹理钳制，整圈光晕都在采样
                           「画面最外一行/一列」像素，1 个像素被拉成几十个像素。
  B. 镜像反向查找        —— 本脚本做法：沿「由外向内」的反方向回走同样距离，
                           去画面内部取真实像素，再用三角波折叠回 [0,1]。

输出：
  compare-sharp.png  —— 模糊 = 0，并带 8× 放大镜，用来看边缘台阶
  compare-blur.png   —— 模糊 = 32%，接近原插件默认观感
"""

import math
import os
import numpy as np
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

SRC_W, SRC_H = 1024, 576
PANE_W, PANE_H = 800, 600

# 视频矩形在画布 uv 空间中的位置
RECT_W = 0.62
RECT_H = RECT_W * (PANE_W / PANE_H) * 9 / 16
RECT = ((1 - RECT_W) / 2, (1 - RECT_H) / 2, RECT_W, RECT_H)
MARGIN = (0.20, 0.20)          # 光晕宽度（视频 uv 单位）
ASPECT = 16 / 9

GOLDEN = 2.39996323
TAPS = 24


# --------------------------------------------------------------------------
# 1. 生成「测试视频画面」
# --------------------------------------------------------------------------
def make_source(w=SRC_W, h=SRC_H, ss=4):
    """4 倍超采样绘制，再缩小做抗锯齿。"""
    W, H = w * ss, h * ss

    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    u = xx / (W - 1)
    v = yy / (H - 1)
    t = np.clip(u * 0.55 + v * 0.45, 0, 1)

    c0 = np.array([0.086, 0.137, 0.239], np.float32)   # 亮蓝
    c1 = np.array([0.047, 0.075, 0.133], np.float32)   # 中蓝
    c2 = np.array([0.020, 0.027, 0.050], np.float32)   # 近黑
    lo = c0 + (c1 - c0) * np.clip(t * 2, 0, 1)[..., None]
    hi = c1 + (c2 - c1) * np.clip(t * 2 - 1, 0, 1)[..., None]
    base = np.where((t < 0.5)[..., None], lo, hi)

    # 中心暖色发光：用来展示「越往外取色越靠近画面中央」——光晕外圈会亮起来
    gx = (xx - W * 0.5) / (W * 0.40)
    gy = (yy - H * 0.5) / (H * 0.60)
    gd = np.sqrt(gx * gx + gy * gy)
    glow = np.clip(1.0 - gd, 0.0, 1.0) ** 2.0
    warm = np.array([1.0, 0.88, 0.66], np.float32)
    base = base * (1 - glow[..., None] * 0.88) + warm[None, None, :] * (glow[..., None] * 0.88)

    im = Image.fromarray((np.clip(base, 0, 1) * 255).astype(np.uint8))
    dr = ImageDraw.Draw(im)

    # 右上橙色圆（部分出界）
    r = W * 0.27
    cx, cy = W * 0.82, H * 0.27
    dr.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(217, 72, 15))
    dr.ellipse([cx - r * 0.72, cy - r * 0.72, cx + r * 0.72, cy + r * 0.72], fill=(255, 159, 67))
    dr.ellipse([cx - r * 0.40, cy - r * 0.46, cx + r * 0.28, cy + r * 0.10], fill=(255, 224, 178))

    # 左下青色圆（贴左边）
    r2 = W * 0.24
    cx2, cy2 = -W * 0.02, H * 0.80
    dr.ellipse([cx2 - r2, cy2 - r2, cx2 + r2, cy2 + r2], fill=(34, 211, 238))
    dr.ellipse([cx2 - r2 * 0.6, cy2 - r2 * 0.62, cx2 + r2 * 0.25, cy2 + r2 * 0.05], fill=(165, 243, 252))

    # 45° 白色斜带（与边界斜交，最容易暴露拉伸锯齿）
    ang = math.radians(45)
    L = W * 1.6
    thick = H * 0.075
    ca, sa = math.cos(ang), math.sin(ang)
    cx3, cy3 = W * 0.5, H * 0.5
    pts = []
    for px, py in [(-L, -thick), (L, -thick), (L, thick), (-L, thick)]:
        pts.append((cx3 + px * ca - py * sa, cy3 + px * sa + py * ca))
    dr.polygon(pts, fill=(236, 240, 245))

    # 底部绿色渐变条
    gh = int(H * 0.16)
    for i in range(gh):
        a = 1 - i / gh
        y = H - gh + i
        dr.line([(0, y), (W, y)], fill=(int(52 * a), int(211 * a), int(153 * a)))

    # 顶部 4px 紫色细线
    dr.rectangle([0, 0, W, 4 * ss], fill=(167, 139, 250))

    # 高频栅格
    for x in range(0, W, 12 * ss):
        dr.line([(x, H * 0.30), (x, H * 0.44)], fill=(70, 74, 84), width=ss)

    return im.resize((w, h), Image.LANCZOS)


# --------------------------------------------------------------------------
# 2. 采样
# --------------------------------------------------------------------------
def fold(x):
    """三角波折叠：把任意坐标折回 [0,1]（等价镜像延拓）"""
    return 1.0 - np.abs(np.mod(x, 2.0) - 1.0)


def bilinear(tex, u, v):
    h, w = tex.shape[:2]
    x = np.clip(u, 0, 1) * (w - 1)
    y = np.clip(v, 0, 1) * (h - 1)
    x0 = np.floor(x).astype(np.int32)
    y0 = np.floor(y).astype(np.int32)
    x1 = np.minimum(x0 + 1, w - 1)
    y1 = np.minimum(y0 + 1, h - 1)
    fx = (x - x0)[..., None]
    fy = (y - y0)[..., None]
    return (tex[y0, x0] * (1 - fx) * (1 - fy) +
            tex[y0, x1] * fx * (1 - fy) +
            tex[y1, x0] * (1 - fx) * fy +
            tex[y1, x1] * fx * fy)


def make_sampler(tex, mode, lookback, depth=1.0):
    """mode: clamp = 边缘拉伸 / mirror = 镜像折叠 / sweep = 沿扩散方向反查"""
    if mode == 'clamp':
        def sample(u, v):
            # 原插件：越界 UV 被 CLAMP_TO_EDGE 钳制 → 永远取最外一行/一列
            return bilinear(tex, np.clip(u, 0, 1), np.clip(v, 0, 1))

    elif mode == 'origin':
        # 原版几何：光晕层画布 = 视频放大 scale 倍（中心对齐），
        # 画布上铺的是「放大后的视频」，所以光晕区看到的是边缘 (scale-1)/2/scale 宽的那一条，
        # 而不是 1px 被拉长。超出画布的部分由纹理 CLAMP_TO_EDGE 兜住。
        sc = 1.0 + 2.0 * MARGIN[1]
        mm = (sc - 1.0) / 2.0

        def sample(u, v):
            cu = (u + mm) / sc
            cv = (v + mm) / sc
            return bilinear(tex, np.clip(cu, 0, 1), np.clip(cv, 0, 1))

    elif mode == 'mirror':
        def sample(u, v):
            # 镜像：反方向回走同样距离，再折叠回画面内（会出现对称副本）
            cu = np.clip(u, 0, 1)
            cv = np.clip(v, 0, 1)
            return bilinear(tex,
                            fold(cu - (u - cu) * lookback),
                            fold(cv - (v - cv) * lookback))

    else:  # sweep
        def sample(u, v):
            # 以画面中心为极点，沿半径向外扩散；反查时沿同一条半径回到画面内。
            cx, cy = ASPECT * 0.5, 0.5
            hu = u * ASPECT
            hv = v
            vx = hu - cx
            vy = hv - cy
            r = np.sqrt(vx * vx + vy * vy)
            safe = np.maximum(r, 1e-6)
            dx = np.where(r > 1e-6, vx / safe, 0.0)
            dy = np.where(r > 1e-6, vy / safe, 1.0)

            # 这条半径与画面边界的交点距离
            tx = (ASPECT * 0.5) / np.maximum(np.abs(dx), 1e-6)
            ty = 0.5 / np.maximum(np.abs(dy), 1e-6)
            rEdge = np.minimum(tx, ty)

            # 画面内：直接取真实像素
            base = bilinear(tex, np.clip(hu, 0, ASPECT) / ASPECT, np.clip(hv, 0, 1))

            # 画面外：越往外，取的颜色越靠近画面中央（沿线方向严格线性）
            # 用「这条射线上光晕的外边界半径」归一化，各方向都铺满 [0,1]
            m = MARGIN[1]
            to_x = (ASPECT * 0.5 + m) / np.maximum(np.abs(dx), 1e-6)
            to_y = (0.5 + m) / np.maximum(np.abs(dy), 1e-6)
            rOuter = np.minimum(to_x, to_y)
            span = np.maximum(rOuter - rEdge, 1e-4)
            tR = np.clip((r - rEdge) / span, 0.0, 1.0)
            sMax = m + (rEdge - m) * depth
            rr = rEdge - tR * sMax
            px = cx + dx * rr
            py = cy + dy * rr
            out = bilinear(tex, np.clip(px, 0, ASPECT) / ASPECT, np.clip(py, 0, 1))

            return np.where((r <= rEdge)[..., None], base, out)
    return sample


def render_pane(tex, mode, blur=0.0, lookback=1.0, depth=1.0):
    W, H = PANE_W, PANE_H
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    cu = (xx + 0.5) / W
    cv = (yy + 0.5) / H
    vu = (cu - RECT[0]) / RECT[2]
    vv = (cv - RECT[1]) / RECT[3]

    sample = make_sampler(tex, mode, lookback, depth)

    # 逐像素角度抖动：把螺旋采样核的「花瓣」打散成噪声
    jitter = np.mod(np.sin(xx * 12.9898 + yy * 78.233) * 43758.5453, 1.0) * 6.2831853

    def blurred(u, v):
        if blur <= 1e-5:
            return sample(u, v)
        acc = sample(u, v) * 0.18
        wsum = 0.18
        for i in range(TAPS):
            fi = i + 0.5
            rad_n = math.sqrt(fi / TAPS)
            rad = rad_n * blur
            w = math.exp(-2.8 * rad_n * rad_n) + 1e-4
            ang = fi * GOLDEN + jitter
            offu = np.cos(ang) * rad
            offv = np.sin(ang) * rad / ASPECT
            acc = acc + sample(u + offu, v + offv) * w
            wsum += w
        return acc / wsum

    inside = (vu > 0.0015) & (vu < 0.9985) & (vv > 0.0015) & (vv < 0.9985)

    # alpha 用欧氏距离（等值线圆角，角落无直角硬边）
    hu_a = vu * ASPECT
    hv_a = vv
    over_u = np.maximum(np.maximum(-hu_a, hu_a - ASPECT), 0)
    over_v = np.maximum(np.maximum(-hv_a, hv_a - 1), 0)
    dist = np.sqrt(over_u * over_u + over_v * over_v)
    t = np.clip(dist / MARGIN[1], 0, 1)
    k = np.clip((t - 0.10) / 0.90, 0, 1)
    alpha = (1 - k) ** 0.85

    halo = blurred(vu, vv)
    bg = np.array([0.055, 0.060, 0.075], np.float32)
    out = halo * alpha[..., None] + bg * (1 - alpha[..., None])

    vid = bilinear(tex, np.clip(vu, 0, 1), np.clip(vv, 0, 1))
    out = np.where(inside[..., None], vid, out)
    return np.clip(out, 0, 1)


# --------------------------------------------------------------------------
# 3. 拼图
# --------------------------------------------------------------------------
def load_font(size):
    for name in ('msyh.ttc', 'msyhbd.ttc', 'simhei.ttf', 'arial.ttf'):
        p = os.path.join(os.environ.get('WINDIR', r'C:\Windows'), 'Fonts', name)
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                pass
    return ImageFont.load_default()


def to_img(arr):
    return Image.fromarray((np.clip(arr, 0, 1) * 255).astype(np.uint8))


def crop_zoom(arr, x0, y0, w, h, scale):
    im = to_img(arr)
    box = (int(x0), int(y0), int(x0 + w), int(y0 + h))
    return im.crop(box).resize((int(w * scale), int(h * scale)), Image.BILINEAR)


def compose_and_save(path, blur, with_zoom, depth=1.0):
    tex = np.asarray(make_source(), dtype=np.float32) / 255.0

    a = render_pane(tex, 'clamp', blur=blur)
    b = render_pane(tex, 'sweep', blur=blur, depth=depth)

    pad = 24
    gap = 40
    title_h = 72
    zoom_h = PANE_H if with_zoom else 0
    faint = load_font(21)
    bold = load_font(25)
    small = load_font(17)

    W = pad * 2 + PANE_W * 2 + gap
    H = pad + title_h + PANE_H + (gap + title_h + zoom_h if with_zoom else 0) + pad + 28
    canvas = Image.new('RGB', (W, H), (10, 11, 15))
    dr = ImageDraw.Draw(canvas)

    dr.text((pad, 12), '同一画面 · 同一模糊与透明度 · 只改画面外侧的取色方式', font=bold, fill=(228, 230, 235))

    xa = pad
    xb = pad + PANE_W + gap
    ya = pad + title_h

    dr.text((xa, ya - 30), 'A  原版：边缘像素拉伸 (CLAMP_TO_EDGE)', font=faint, fill=(251, 113, 133))
    dr.text((xb, ya - 30), 'B  本脚本：极坐标取色（越往外越靠近中心）', font=faint, fill=(110, 231, 183))

    canvas.paste(to_img(a), (xa, ya))
    canvas.paste(to_img(b), (xb, ya))

    if with_zoom:
        yz = ya + PANE_H + gap + title_h
        dr.text((xa, yz - 30), '8× 放大：画面左上角', font=faint, fill=(251, 113, 133))
        dr.text((xb, yz - 30), '8× 放大：画面左上角', font=faint, fill=(110, 231, 183))

        cx = RECT[0] * PANE_W
        cy = RECT[1] * PANE_H
        zw, zh = 100, 75
        zx = cx - 72
        zy = cy - 56

        canvas.paste(crop_zoom(a, zx, zy, zw, zh, 8), (xa, yz))
        canvas.paste(crop_zoom(b, zx, zy, zw, zh, 8), (xb, yz))

        # 放大镜里标一下画面边界
        for x0, col in ((xa, (251, 113, 133)), (xb, (110, 231, 183))):
            bx = x0 + (cx - zx) * 8
            by = yz + (cy - zy) * 8
            dr.line([(bx, yz), (bx, yz + zoom_h)], fill=col, width=1)
            dr.line([(x0, by), (x0 + PANE_W, by)], fill=col, width=1)

    dr.text((pad, H - 24),
            '模糊 = %d%%　·　左图整圈光晕只采样最外一行/列像素（被拉长）；右图以画面中心为极点径向取色，越往外取到的颜色越靠近画面中央'
            % (int(blur * 100)), font=small, fill=(139, 141, 150))

    canvas.save(path)
    print('saved:', path, canvas.size)


if __name__ == '__main__':
    # 不开模糊的总览对比（看取色本身）
    compose_and_save(os.path.join(ROOT, 'compare-noblur.png'), 0.0, False)
    # 不开模糊 + 8× 放大（看边缘台阶）
    compose_and_save(os.path.join(ROOT, 'compare-sharp.png'), 0.0, True)
    # 开模糊后的实际观感
    compose_and_save(os.path.join(ROOT, 'compare-blur.png'), 0.32, False)
    # 内向强度 0.5（1:1 与压到中心的折中）
    compose_and_save(os.path.join(ROOT, 'compare-half.png'), 0.0, False, depth=0.5)
    compose_and_save(os.path.join(ROOT, 'compare-zero.png'), 0.0, False, depth=0.0)
