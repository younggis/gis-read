"""
dem_to_terrain.py — DEM GeoTIFF → Cesium quantized-mesh-1.0 地形切片

依赖: rasterio, numpy, scipy
不依赖: GDAL Python bindings

用法:
    python dem_to_terrain.py input.tif output_dir [--max-level 8] [--grid-size 32] [--no-compress]

示例:
    python dem_to_terrain.py dem.tif ./tiles --max-level 10 --grid-size 32

输出目录结构:
    output_dir/
    ├── layer.json
    └── {z}/{x}/{y}.terrain   (gzip 压缩)
"""

import argparse
import gzip
import json
import math
import os
import struct
import sys
from dataclasses import dataclass, field
from typing import List, Optional, Tuple

import numpy as np
import rasterio
from rasterio.transform import rowcol
from rasterio.warp import calculate_default_transform, reproject, Resampling
from scipy.ndimage import map_coordinates


# ═══════════════════════════════════════════════════════════
# 常量
# ═══════════════════════════════════════════════════════════
MAX_Q       = 32767          # quantized-mesh 量化最大值
WGS84_A     = 6378137.0     # 长半轴
WGS84_E2    = 0.00669437999014  # 第一偏心率²
NODATA_FILL = 0.0            # nodata 替换值


# ═══════════════════════════════════════════════════════════
# 坐标转换
# ═══════════════════════════════════════════════════════════
def llh_to_ecef(lon_deg: float, lat_deg: float, h: float = 0.0):
    lon = math.radians(lon_deg)
    lat = math.radians(lat_deg)
    sin_lat = math.sin(lat)
    cos_lat = math.cos(lat)
    N = WGS84_A / math.sqrt(1 - WGS84_E2 * sin_lat * sin_lat)
    x = (N + h) * cos_lat * math.cos(lon)
    y = (N + h) * cos_lat * math.sin(lon)
    z = (N * (1 - WGS84_E2) + h) * sin_lat
    return x, y, z


def compute_bounding_sphere(west, south, east, north, min_h, max_h):
    """用瓦片四角 + 顶部四角的 ECEF 坐标求包围球（简化：外接球）"""
    corners = [
        (west,  south, min_h), (east,  south, min_h),
        (west,  north, min_h), (east,  north, min_h),
        (west,  south, max_h), (east,  south, max_h),
        (west,  north, max_h), (east,  north, max_h),
    ]
    pts = np.array([llh_to_ecef(*c) for c in corners])
    center = pts.mean(axis=0)
    radius = float(np.max(np.linalg.norm(pts - center, axis=1)))
    return center, radius


def compute_horizon_occlusion(west, south, east, north, max_h):
    """
    地平线遮挡点：取最高点的 ECEF 坐标，缩放到椭球面外侧。
    简化实现：取瓦片中心最高高程点。
    """
    cx = (west + east) / 2
    cy = (south + north) / 2
    x, y, z = llh_to_ecef(cx, cy, max_h)
    # 沿径向向外延伸 1% 作为遮挡点（Cesium 能接受的保守值）
    scale = 1.01
    return x * scale, y * scale, z * scale


# ═══════════════════════════════════════════════════════════
# Tiling Scheme（GeographicTilingScheme，与 Cesium 默认一致）
# ═══════════════════════════════════════════════════════════
def tile_bbox(z: int, x: int, y: int) -> Tuple[float, float, float, float]:
    """
    返回 (west, south, east, north) 单位：度
    Cesium GeographicTilingScheme:
      level 0 → 2列×1行，每格 180°×180°
      y=0 是南半球（TMS 约定，Cesium terrain 用 TMS y 方向）
    """
    n_cols = 2 << z          # 2 * 2^z
    n_rows = 1 << z          # 2^z
    tile_w = 360.0 / n_cols
    tile_h = 180.0 / n_rows
    west  = -180.0 + x * tile_w
    south = -90.0  + y * tile_h
    east  = west  + tile_w
    north = south + tile_h
    return west, south, east, north


def tiles_for_level(z: int, dem_west, dem_south, dem_east, dem_north):
    """返回与 DEM 范围相交的所有 (x, y) 瓦片"""
    n_cols = 2 << z
    n_rows = 1 << z
    tile_w = 360.0 / n_cols
    tile_h = 180.0 / n_rows

    x_min = max(0,        int(math.floor((dem_west  + 180.0) / tile_w)))
    x_max = min(n_cols-1, int(math.floor((dem_east  + 180.0 - 1e-9) / tile_w)))
    y_min = max(0,        int(math.floor((dem_south +  90.0) / tile_h)))
    y_max = min(n_rows-1, int(math.floor((dem_north +  90.0 - 1e-9) / tile_h)))

    for x in range(x_min, x_max + 1):
        for y in range(y_min, y_max + 1):
            yield x, y


# ═══════════════════════════════════════════════════════════
# DEM 采样（双线性插值，不依赖 GDAL）
# ═══════════════════════════════════════════════════════════
class DEMSampler:
    """把 WGS84 经纬度映射到 DEM 数组并双线性插值"""

    def __init__(self, dem_array: np.ndarray, transform, nodata=None):
        self.dem = dem_array.astype(np.float64)
        self.transform = transform
        self.nodata = nodata
        # 1. 精确匹配 nodata（含容差，避免浮点误差漏掉 -32768.0）
        if nodata is not None:
            mask = np.abs(self.dem - nodata) < 1.0
            self.dem[mask] = NODATA_FILL
        # 2. 过滤超出合理高程范围的值（-500m 以下或 9000m 以上视为无效）
        self.dem = np.where(
            (self.dem > -500) & (self.dem < 9000),
            self.dem,
            NODATA_FILL
        )
        # 3. 填充 NaN/Inf
        self.dem = np.where(np.isfinite(self.dem), self.dem, NODATA_FILL)
        # 打印过滤后真实高程范围
        valid = self.dem[self.dem > NODATA_FILL + 1]
        if valid.size:
            print(f"[DEM] 过滤 nodata 后高程: {valid.min():.2f} ~ {valid.max():.2f} m")

    def sample(self, lons: np.ndarray, lats: np.ndarray) -> np.ndarray:
        """
        输入经纬度数组（度），返回高程数组（米）。
        使用 rasterio transform 把经纬度转成行列号，再用 scipy map_coordinates 插值。
        """
        # Affine: (row, col) ← transform 的逆变换
        inv = ~self.transform
        # inv * (lon, lat) → (col, row)  （注意 Affine 先 col 后 row）
        cols_f = inv.a * lons + inv.b * lats + inv.c
        rows_f = inv.d * lons + inv.e * lats + inv.f

        # map_coordinates：坐标顺序是 (row, col)
        coords = np.array([rows_f.ravel(), cols_f.ravel()])
        h = map_coordinates(self.dem, coords, order=1, mode='nearest')
        return h.reshape(lons.shape)


# ═══════════════════════════════════════════════════════════
# ZigZag + Delta 编码
# ═══════════════════════════════════════════════════════════
def encode_delta_zigzag(vals: List[int]) -> List[int]:
    out, prev = [], 0
    for v in vals:
        delta = v - prev
        # int16 截断
        delta = (delta + 32768) % 65536 - 32768
        enc = ((delta << 1) ^ (delta >> 15)) & 0xffff
        out.append(enc)
        prev = v
    return out


# ═══════════════════════════════════════════════════════════
# High-Water-Mark 编码（三角形索引）
# ═══════════════════════════════════════════════════════════
def encode_high_water_mark(indices: List[int]) -> List[int]:
    out, highest = [], 0
    for idx in indices:
        out.append(highest - idx)
        if idx == highest:
            highest += 1
    return out


# ═══════════════════════════════════════════════════════════
# 规则网格三角化
# ═══════════════════════════════════════════════════════════
def make_grid_mesh(grid_size: int):
    """
    生成 grid_size×grid_size 规则网格的顶点 uv 量化坐标和三角形索引。
    返回 (u_list, v_list, triangles, west_idx, south_idx, east_idx, north_idx)
    """
    n = grid_size
    u_list, v_list = [], []
    for r in range(n):
        for c in range(n):
            u_list.append(round(c / (n - 1) * MAX_Q))
            v_list.append(round(r / (n - 1) * MAX_Q))

    triangles = []
    for r in range(n - 1):
        for c in range(n - 1):
            tl = r * n + c
            tr = r * n + c + 1
            bl = (r + 1) * n + c
            br = (r + 1) * n + c + 1
            triangles += [tl, tr, bl]
            triangles += [tr, br, bl]

    west_idx  = [r * n       for r in range(n)]
    south_idx = [c           for c in range(n)]
    east_idx  = [r * n + n-1 for r in range(n)]
    north_idx = [(n-1)*n + c for c in range(n)]

    return u_list, v_list, triangles, west_idx, south_idx, east_idx, north_idx


# ═══════════════════════════════════════════════════════════
# 写 .terrain 文件
# ═══════════════════════════════════════════════════════════
def write_terrain(
    west, south, east, north,
    u_list, v_list, h_list,
    triangles,
    west_idx, south_idx, east_idx, north_idx,
    compress: bool = True
) -> bytes:
    min_h = float(min(h_list))
    max_h = float(max(h_list))
    # 量化高度：0~MAX_Q
    h_range = max_h - min_h if max_h > min_h else 1.0
    h_q = [round((h - min_h) / h_range * MAX_Q) for h in h_list]

    vertex_count = len(u_list)
    triangle_count = len(triangles) // 3
    use_32bit = vertex_count > 65536
    idx_fmt = '<I' if use_32bit else '<H'
    idx_size = 4   if use_32bit else 2

    # ── Header ──────────────────────────────
    cx, cy, cz = llh_to_ecef((west+east)/2, (south+north)/2, (min_h+max_h)/2)
    bs_center, bs_radius = compute_bounding_sphere(west, south, east, north, min_h, max_h)
    hox, hoy, hoz = compute_horizon_occlusion(west, south, east, north, max_h)

    buf = bytearray()
    buf += struct.pack('<ddd', cx, cy, cz)
    buf += struct.pack('<ff', min_h, max_h)
    buf += struct.pack('<dddd', bs_center[0], bs_center[1], bs_center[2], bs_radius)
    buf += struct.pack('<ddd', hox, hoy, hoz)

    # ── Vertex Data ─────────────────────────
    buf += struct.pack('<I', vertex_count)
    for arr in (u_list, v_list, h_q):
        for v in encode_delta_zigzag(arr):
            buf += struct.pack('<H', v)

    # ── 4字节对齐（32bit 索引时）────────────
    if use_32bit and len(buf) % 4 != 0:
        buf += b'\x00\x00'

    # ── Index Data ──────────────────────────
    hwm = encode_high_water_mark(triangles)
    buf += struct.pack('<I', triangle_count)
    for v in hwm:
        buf += struct.pack(idx_fmt, v & (0xFFFFFFFF if use_32bit else 0xFFFF))

    # ── Edge Indices ────────────────────────
    for edge in (west_idx, south_idx, east_idx, north_idx):
        buf += struct.pack('<I', len(edge))
        for v in edge:
            buf += struct.pack(idx_fmt, v)

    raw = bytes(buf)
    return gzip.compress(raw) if compress else raw


# ═══════════════════════════════════════════════════════════
# 读取 DEM，重投影到 EPSG:4326（若需要）
# ═══════════════════════════════════════════════════════════
def load_dem_wgs84(tif_path: str):
    """
    读取 GeoTIFF，若不是 EPSG:4326 则在内存中重投影。
    返回 (dem_array, transform, bounds_wgs84: (west,south,east,north), nodata)
    """
    with rasterio.open(tif_path) as src:
        src_crs = src.crs
        nodata  = src.nodata
        src_transform = src.transform
        src_width  = src.width
        src_height = src.height

        # 判断是否需要重投影
        from rasterio.crs import CRS
        wgs84 = CRS.from_epsg(4326)

        if src_crs and src_crs.to_epsg() == 4326:
            dem = src.read(1).astype(np.float64)
            transform = src_transform
            bounds = src.bounds
            west, south, east, north = bounds.left, bounds.bottom, bounds.right, bounds.top
            print(f"[DEM] CRS: EPSG:4326，无需重投影")
        else:
            print(f"[DEM] CRS: {src_crs}，重投影到 EPSG:4326 …")
            dst_transform, dst_width, dst_height = calculate_default_transform(
                src_crs, wgs84, src_width, src_height, *src.bounds
            )
            dem = np.zeros((dst_height, dst_width), dtype=np.float64)
            reproject(
                source=rasterio.band(src, 1),
                destination=dem,
                src_transform=src_transform,
                src_crs=src_crs,
                dst_transform=dst_transform,
                dst_crs=wgs84,
                resampling=Resampling.bilinear,
                src_nodata=nodata,
                dst_nodata=NODATA_FILL,
            )
            transform = dst_transform
            # 从 transform 推算边界
            west  = dst_transform.c
            north = dst_transform.f
            east  = west  + dst_transform.a * dst_width
            south = north + dst_transform.e * dst_height

        print(f"[DEM] 范围: ({west:.4f}, {south:.4f}, {east:.4f}, {north:.4f})")
        print(f"[DEM] 大小: {dem.shape[1]}×{dem.shape[0]}  nodata={nodata}")
        print(f"[DEM] 高程: {np.nanmin(dem):.2f} ~ {np.nanmax(dem):.2f} m\n")

    return dem, transform, (west, south, east, north), nodata


# ═══════════════════════════════════════════════════════════
# layer.json 生成
# ═══════════════════════════════════════════════════════════
def write_layer_json(output_dir, dem_bounds, max_level, available_tiles):
    """
    available_tiles: dict { z: set of (x, y) }
    """
    west, south, east, north = dem_bounds

    available = []
    for z in range(max_level + 1):
        level_tiles = available_tiles.get(z, set())
        if z == 0:
            # Level 0 强制声明全覆盖（两个瓦片 x=0,1 y=0 都已写入）
            # Cesium 初始化时依赖这个范围判断 terrain provider 是否可用
            available.append([{"startX": 0, "startY": 0, "endX": 1, "endY": 0}])
            continue
        if not level_tiles:
            available.append([])
            continue
        xs = [t[0] for t in level_tiles]
        ys = [t[1] for t in level_tiles]
        available.append([{
            "startX": min(xs), "startY": min(ys),
            "endX":   max(xs), "endY":   max(ys)
        }])

    layer = {
        "tilejson":   "2.1.0",
        "format":     "quantized-mesh-1.0",
        "version":    "1.0.0",
        "scheme":     "tms",
        "tiles":      ["{z}/{x}/{y}.terrain"],
        "projection": "EPSG:4326",
        "bounds":     [west, south, east, north],
        "available":  available,
    }
    path = os.path.join(output_dir, "layer.json")
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(layer, f, indent=2)
    print(f"[写入] {path}")


# ═══════════════════════════════════════════════════════════
# 主流程
# ═══════════════════════════════════════════════════════════
def make_blank_terrain(west, south, east, north, compress=True) -> bytes:
    """
    生成一个高程全为 0 的空白占位瓦片。
    Cesium 初始化时会请求 level 0 的所有瓦片（x=0,1 y=0），
    超出 DEM 范围的瓦片必须用占位瓦片填充，否则 Cesium 报错并隐藏地球。
    """
    n = 4   # 最小网格，节省空间
    u_list, v_list, triangles, w_idx, s_idx, e_idx, n_idx = make_grid_mesh(n)
    heights = [0.0] * (n * n)
    return write_terrain(
        west, south, east, north,
        u_list, v_list, heights,
        triangles,
        w_idx, s_idx, e_idx, n_idx,
        compress=compress,
    )


def write_tile(path: str, data: bytes):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'wb') as f:
        f.write(data)


def generate_tiles(
    tif_path:   str,
    output_dir: str,
    max_level:  int  = 8,
    grid_size:  int  = 32,
    compress:   bool = True,
):
    os.makedirs(output_dir, exist_ok=True)

    # 1. 读 DEM
    dem_array, transform, dem_bounds, nodata = load_dem_wgs84(tif_path)
    sampler = DEMSampler(dem_array, transform, nodata)
    dem_west, dem_south, dem_east, dem_north = dem_bounds

    # 2. 预生成规则网格 uv（所有瓦片共用）
    u_list, v_list, triangles, w_idx, s_idx, e_idx, n_idx = make_grid_mesh(grid_size)
    u_norm = np.array(u_list, dtype=np.float64) / MAX_Q
    v_norm = np.array(v_list, dtype=np.float64) / MAX_Q

    available_tiles: dict = {}
    total_data = 0
    total_blank = 0

    # ── 缓存空白瓦片（level 0 两个、level 1 四个… 共用同一份字节即可）
    _blank_cache: dict = {}
    def get_blank(z, x, y):
        key = z
        if key not in _blank_cache:
            bw, bs, be, bn = tile_bbox(z, x, y)
            _blank_cache[key] = make_blank_terrain(bw, bs, be, bn, compress=compress)
        return _blank_cache[key]

    for z in range(max_level + 1):
        n_cols = 2 << z   # 该层级总列数
        n_rows = 1 << z   # 该层级总行数

        # Cesium 对每个层级都会请求全部瓦片格（通过 available 判断哪些有数据）
        # 但 level 0 是强制请求的，必须保证文件存在
        # 策略：有 DEM 数据的写真实瓦片，其余写空白占位瓦片
        dem_tiles  = set(tiles_for_level(z, dem_west, dem_south, dem_east, dem_north))
        # level 0 的全部瓦片必须存在（x=0,1 y=0）
        # level 1+ Cesium 通过 available 跳过无数据区域，不需要全部占位
        must_exist = set()
        if z == 0:
            must_exist = {(x, y) for x in range(n_cols) for y in range(n_rows)}

        all_tiles = dem_tiles | must_exist
        if not all_tiles:
            continue

        available_tiles[z] = set()
        data_count  = 0
        blank_count = 0

        for x, y in sorted(all_tiles):
            tile_path = os.path.join(output_dir, str(z), str(x), f"{y}.terrain")

            if (x, y) in dem_tiles:
                # ── 真实高程瓦片 ──────────────────────────
                west, south, east, north = tile_bbox(z, x, y)
                lons = west  + u_norm * (east  - west)
                lats = south + v_norm * (north - south)
                heights = sampler.sample(lons, lats)
                terrain_bytes = write_terrain(
                    west, south, east, north,
                    u_list, v_list, list(heights),
                    triangles, w_idx, s_idx, e_idx, n_idx,
                    compress=compress,
                )
                write_tile(tile_path, terrain_bytes)
                available_tiles[z].add((x, y))
                data_count  += 1
                total_data  += 1
            else:
                # ── 空白占位瓦片（仅 level 0 必须）────────
                blank_bytes = get_blank(z, x, y)
                write_tile(tile_path, blank_bytes)
                blank_count += 1
                total_blank += 1

        desc = f"{data_count} 个真实"
        if blank_count:
            desc += f" + {blank_count} 个空白占位"
        print(f"[Level {z:2d}] {desc}")

    # 3. 写 layer.json
    write_layer_json(output_dir, dem_bounds, max_level, available_tiles)
    print(f"\n✓ 完成：真实瓦片 {total_data} 个，空白占位 {total_blank} 个 → {output_dir}")


# ═══════════════════════════════════════════════════════════
# CLI
# ═══════════════════════════════════════════════════════════
def main():
    parser = argparse.ArgumentParser(
        description="DEM GeoTIFF → Cesium quantized-mesh terrain tiles"
    )
    parser.add_argument("input",       help="输入 DEM GeoTIFF 路径")
    parser.add_argument("output",      help="输出目录")
    parser.add_argument("--max-level", type=int, default=8,
                        help="最大切片层级（默认 8）")
    parser.add_argument("--grid-size", type=int, default=32,
                        help="每瓦片网格密度，建议 16/32/64（默认 32）")
    parser.add_argument("--no-compress", action="store_true",
                        help="不做 gzip 压缩（调试用）")
    args = parser.parse_args()

    if not os.path.exists(args.input):
        print(f"错误：找不到文件 {args.input}", file=sys.stderr)
        sys.exit(1)

    generate_tiles(
        tif_path   = args.input,
        output_dir = args.output,
        max_level  = args.max_level,
        grid_size  = args.grid_size,
        compress   = not args.no_compress,
    )


if __name__ == "__main__":
    main()