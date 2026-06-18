#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
shp_to_3dtiles.py — 建筑物 Shapefile → Cesium 3D Tiles (白模)

不依赖 pyshp / GDAL，纯 Python 解析 SHP/DBF。
依赖: pyproj（可选，用于 CRS 转换与精确 ECEF；没有 pyproj 时仅支持 EPSG:4326/WGS84）

用法:
    python shp_to_3dtiles.py <input.shp> <output_dir> [options]

示例:
    python shp_to_3dtiles.py ../data/building.shp ./buildings
    python shp_to_3dtiles.py ../data/building.shp ./buildings --color "#cccccc" --height-field HEIGHT --lod 13
    python shp_to_3dtiles.py ../data/building.shp ./buildings --limit 1000

输出:
    output_dir/
    ├── tileset.json
    └── Tiles/{z}/{x}/{y}.b3dm

说明:
    1. 默认输入坐标系为 EPSG:4326。如果 shp 是投影坐标，请安装 pyproj，并传 --input-crs EPSG:xxxx。
    2. 当前面向建筑白模：支持 Polygon / PolygonZ / PolygonM；忽略 shp 自带 Z/M。
    3. 纯 Python 三角化采用简单耳切法，适合常见建筑轮廓；复杂自相交、多洞面建议先清洗数据。
    4. tileset 采用扁平 children 结构，大数据量可再扩展为四叉树层级 tileset。
"""

from __future__ import annotations

import argparse
import array
import json
import math
import os
import shutil
import struct
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, Iterable, Iterator, List, Optional, Sequence, Tuple

Vec2 = Tuple[float, float]
Vec3 = Tuple[float, float, float]

# Shapefile shape types
NULL_SHAPE = 0
POLYGON = 5
POLYGON_Z = 15
POLYGON_M = 25

WGS84_A = 6378137.0
WGS84_F = 1.0 / 298.257223563
WGS84_E2 = WGS84_F * (2.0 - WGS84_F)
WEB_MERCATOR_MAX_LAT = 85.05112878

GL_ARRAY_BUFFER = 34962
GL_FLOAT = 5126
GL_TRIANGLES = 4


@dataclass
class ShpRecord:
    record_number: int
    rings: List[List[Vec2]]
    bbox: Tuple[float, float, float, float]


@dataclass
class Feature:
    rings_ll: List[List[Vec2]]
    height: float
    base_height: float
    lon_min: float
    lat_min: float
    lon_max: float
    lat_max: float


@dataclass
class TileBucket:
    z: int
    x: int
    y: int
    features: List[Feature] = field(default_factory=list)
    west: float = 180.0
    south: float = 90.0
    east: float = -180.0
    north: float = -90.0
    min_h: float = 0.0
    max_h: float = 0.0

    def add_feature(self, feature: Feature) -> None:
        self.features.append(feature)
        self.west = min(self.west, feature.lon_min)
        self.south = min(self.south, feature.lat_min)
        self.east = max(self.east, feature.lon_max)
        self.north = max(self.north, feature.lat_max)
        self.min_h = min(self.min_h, feature.base_height)
        self.max_h = max(self.max_h, feature.height)


class CoordinateTransformer:
    """Input CRS -> lon/lat and ECEF.

    不依赖 pyproj 时，只支持 EPSG:4326 / WGS84 输入。
    """

    def __init__(self, input_crs: str = "EPSG:4326") -> None:
        self.input_crs = (input_crs or "EPSG:4326").strip()
        self._pyproj = None
        self._to_ll = None
        self._to_ecef = None

        normalized = self.input_crs.upper().replace(" ", "")
        self.is_wgs84_like = normalized in {
            "EPSG:4326",
            "WGS84",
            "WGS84_LATLON",
            "OGC:CRS84",
            "CRS:84",
        }

        try:
            import pyproj  # type: ignore

            self._pyproj = pyproj
            self._to_ll = pyproj.Transformer.from_crs(self.input_crs, "EPSG:4326", always_xy=True)
            self._to_ecef = pyproj.Transformer.from_crs(self.input_crs, "EPSG:4978", always_xy=True)
        except Exception:
            self._pyproj = None
            if not self.is_wgs84_like:
                raise RuntimeError(
                    f"输入坐标系为 {self.input_crs}，但当前环境没有可用 pyproj。"
                    "请安装 pyproj，或先把 Shapefile 转为 EPSG:4326。"
                )

    def to_lonlat(self, x: float, y: float) -> Vec2:
        if self._to_ll is not None:
            lon, lat = self._to_ll.transform(x, y)
            return float(lon), float(lat)
        return float(x), float(y)

    def to_ecef(self, x: float, y: float, h: float) -> Vec3:
        if self._to_ecef is not None:
            ex, ey, ez = self._to_ecef.transform(x, y, h)
            return float(ex), float(ey), float(ez)
        lon, lat = float(x), float(y)
        return geodetic_to_ecef(lon, lat, h)

    def lonlat_to_ecef(self, lon: float, lat: float, h: float) -> Vec3:
        # 这里传入的一定是 EPSG:4326 经纬度，直接用内置公式即可。
        return geodetic_to_ecef(lon, lat, h)


# -----------------------------------------------------------------------------
# SHP / DBF parsing
# -----------------------------------------------------------------------------


def read_shp_polygons(path: Path, limit: Optional[int] = None) -> Iterator[ShpRecord]:
    with path.open("rb") as f:
        header = f.read(100)
        if len(header) != 100:
            raise ValueError("SHP 文件头不足 100 字节，文件可能损坏。")

        file_code = struct.unpack(">i", header[0:4])[0]
        if file_code != 9994:
            raise ValueError(f"不是合法 Shapefile：file code = {file_code}")

        shape_type = struct.unpack("<i", header[32:36])[0]
        if shape_type not in (POLYGON, POLYGON_Z, POLYGON_M, NULL_SHAPE):
            raise ValueError(
                f"当前脚本仅支持 Polygon/PolygonZ/PolygonM，当前 shapeType={shape_type}。"
            )

        emitted = 0
        while True:
            rec_header = f.read(8)
            if not rec_header:
                break
            if len(rec_header) != 8:
                raise ValueError("SHP record header 不完整，文件可能损坏。")

            record_number, content_len_words = struct.unpack(">2i", rec_header)
            content_len = content_len_words * 2
            content = f.read(content_len)
            if len(content) != content_len:
                raise ValueError(f"SHP record {record_number} 内容长度不完整。")

            if content_len < 4:
                continue
            rec_shape_type = struct.unpack("<i", content[0:4])[0]
            if rec_shape_type == NULL_SHAPE:
                continue
            if rec_shape_type not in (POLYGON, POLYGON_Z, POLYGON_M):
                continue

            if content_len < 44:
                continue

            xmin, ymin, xmax, ymax = struct.unpack("<4d", content[4:36])
            num_parts, num_points = struct.unpack("<2i", content[36:44])
            if num_parts <= 0 or num_points <= 0:
                continue

            parts_offset = 44
            points_offset = parts_offset + 4 * num_parts
            points_end = points_offset + 16 * num_points
            if points_end > len(content):
                raise ValueError(f"SHP record {record_number} points 数据越界。")

            parts = list(struct.unpack(f"<{num_parts}i", content[parts_offset:points_offset]))
            points: List[Vec2] = []
            for i in range(num_points):
                px, py = struct.unpack("<2d", content[points_offset + i * 16 : points_offset + i * 16 + 16])
                points.append((float(px), float(py)))

            rings: List[List[Vec2]] = []
            for i, start in enumerate(parts):
                end = parts[i + 1] if i + 1 < len(parts) else num_points
                if start < 0 or end > num_points or start >= end:
                    continue
                ring = clean_ring(points[start:end])
                if len(ring) >= 3:
                    rings.append(ring)

            if not rings:
                continue

            yield ShpRecord(record_number=record_number, rings=rings, bbox=(xmin, ymin, xmax, ymax))
            emitted += 1
            if limit is not None and emitted >= limit:
                break


def read_dbf(path: Path, encoding: str = "utf-8", limit: Optional[int] = None) -> List[Dict[str, object]]:
    if not path.exists():
        return []

    with path.open("rb") as f:
        header = f.read(32)
        if len(header) < 32:
            raise ValueError("DBF 文件头不足 32 字节，文件可能损坏。")

        num_records = struct.unpack("<I", header[4:8])[0]
        header_len = struct.unpack("<H", header[8:10])[0]
        record_len = struct.unpack("<H", header[10:12])[0]

        fields = []
        while True:
            desc = f.read(32)
            if not desc:
                raise ValueError("DBF 字段描述未找到结束符 0x0D。")
            if desc[0] == 0x0D:
                break
            name_raw = desc[0:11].split(b"\x00", 1)[0]
            try:
                name = name_raw.decode("ascii", errors="ignore").strip()
            except Exception:
                name = name_raw.decode(encoding, errors="ignore").strip()
            field_type = chr(desc[11])
            field_len = desc[16]
            decimals = desc[17]
            if name:
                fields.append((name, field_type, field_len, decimals))

        f.seek(header_len)
        records: List[Dict[str, object]] = []
        max_records = num_records if limit is None else min(num_records, limit)
        for _ in range(max_records):
            raw = f.read(record_len)
            if len(raw) < record_len:
                break
            deleted = raw[0:1] == b"*"
            pos = 1
            row: Dict[str, object] = {"__deleted__": deleted}
            for name, field_type, field_len, decimals in fields:
                cell = raw[pos : pos + field_len]
                pos += field_len
                row[name] = parse_dbf_value(cell, field_type, encoding)
            records.append(row)
        return records


def parse_dbf_value(raw: bytes, field_type: str, encoding: str) -> object:
    text = decode_dbf_text(raw, encoding).strip()
    if text == "":
        return None

    ft = field_type.upper()
    if ft in ("N", "F", "B", "Y"):
        text2 = text.replace(",", "")
        try:
            if any(ch in text2 for ch in ".eE"):
                return float(text2)
            return int(text2)
        except ValueError:
            try:
                return float(text2)
            except ValueError:
                return text
    if ft == "L":
        return text.upper() in ("Y", "T", "1")
    if ft == "D" and len(text) == 8 and text.isdigit():
        return f"{text[0:4]}-{text[4:6]}-{text[6:8]}"
    return text


def decode_dbf_text(raw: bytes, encoding: str) -> str:
    for enc in (encoding, "utf-8", "gbk", "gb18030", "latin1"):
        try:
            return raw.decode(enc)
        except Exception:
            continue
    return raw.decode("latin1", errors="replace")


# -----------------------------------------------------------------------------
# Geometry helpers
# -----------------------------------------------------------------------------


def clean_ring(points: Sequence[Vec2], eps: float = 1e-12) -> List[Vec2]:
    out: List[Vec2] = []
    for x, y in points:
        if not (math.isfinite(x) and math.isfinite(y)):
            continue
        if out and abs(out[-1][0] - x) <= eps and abs(out[-1][1] - y) <= eps:
            continue
        out.append((float(x), float(y)))
    if len(out) >= 2 and abs(out[0][0] - out[-1][0]) <= eps and abs(out[0][1] - out[-1][1]) <= eps:
        out.pop()
    return out


def signed_area_2d(ring: Sequence[Vec2]) -> float:
    area = 0.0
    n = len(ring)
    for i in range(n):
        x1, y1 = ring[i]
        x2, y2 = ring[(i + 1) % n]
        area += x1 * y2 - x2 * y1
    return area * 0.5


def ring_centroid(ring: Sequence[Vec2]) -> Vec2:
    a = signed_area_2d(ring)
    if abs(a) < 1e-20:
        xs = [p[0] for p in ring]
        ys = [p[1] for p in ring]
        return sum(xs) / len(xs), sum(ys) / len(ys)

    cx = 0.0
    cy = 0.0
    n = len(ring)
    for i in range(n):
        x0, y0 = ring[i]
        x1, y1 = ring[(i + 1) % n]
        cross = x0 * y1 - x1 * y0
        cx += (x0 + x1) * cross
        cy += (y0 + y1) * cross
    factor = 1.0 / (6.0 * a)
    return cx * factor, cy * factor


def choose_exterior_rings(rings: Sequence[List[Vec2]], mode: str = "auto") -> List[List[Vec2]]:
    valid = [r for r in rings if len(r) >= 3 and abs(signed_area_2d(r)) > 1e-20]
    if not valid:
        return []

    mode = mode.lower()
    if mode == "all":
        return valid
    if mode == "cw":
        chosen = [r for r in valid if signed_area_2d(r) < 0]
        return chosen or [max(valid, key=lambda r: abs(signed_area_2d(r)))]
    if mode == "ccw":
        chosen = [r for r in valid if signed_area_2d(r) > 0]
        return chosen or [max(valid, key=lambda r: abs(signed_area_2d(r)))]

    # auto：以绝对面积总和更大的方向作为外环方向。
    # ESRI Shapefile 规范通常外环为顺时针、洞为逆时针；但不少数据会反过来。
    pos = [r for r in valid if signed_area_2d(r) > 0]
    neg = [r for r in valid if signed_area_2d(r) < 0]
    if not pos:
        return neg
    if not neg:
        return pos
    pos_area = sum(abs(signed_area_2d(r)) for r in pos)
    neg_area = sum(abs(signed_area_2d(r)) for r in neg)
    return pos if pos_area >= neg_area else neg


def ensure_ccw(ring: List[Vec2]) -> List[Vec2]:
    if signed_area_2d(ring) < 0:
        return list(reversed(ring))
    return ring


def triangulate_ear_clip(ring_ccw: Sequence[Vec2]) -> List[Tuple[int, int, int]]:
    """Simple ear clipping for a simple CCW polygon without holes.

    返回原 ring 索引三角形。失败时使用 fan fallback，保证能输出，但复杂凹多边形可能有重叠。
    """
    n = len(ring_ccw)
    if n < 3:
        return []
    if n == 3:
        return [(0, 1, 2)]

    vertices = list(range(n))
    triangles: List[Tuple[int, int, int]] = []
    guard = 0
    max_guard = n * n

    while len(vertices) > 3 and guard < max_guard:
        guard += 1
        ear_found = False
        m = len(vertices)
        for i in range(m):
            i_prev = vertices[(i - 1) % m]
            i_curr = vertices[i]
            i_next = vertices[(i + 1) % m]
            a = ring_ccw[i_prev]
            b = ring_ccw[i_curr]
            c = ring_ccw[i_next]

            if cross2(a, b, c) <= 1e-18:
                continue

            has_inside = False
            for idx in vertices:
                if idx in (i_prev, i_curr, i_next):
                    continue
                if point_in_triangle(ring_ccw[idx], a, b, c):
                    has_inside = True
                    break
            if has_inside:
                continue

            triangles.append((i_prev, i_curr, i_next))
            del vertices[i]
            ear_found = True
            break

        if not ear_found:
            break

    if len(vertices) == 3:
        triangles.append((vertices[0], vertices[1], vertices[2]))
        return triangles

    # fallback：扇形三角化，仅保证可输出。
    return [(0, i, i + 1) for i in range(1, n - 1)]


def cross2(a: Vec2, b: Vec2, c: Vec2) -> float:
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])


def point_in_triangle(p: Vec2, a: Vec2, b: Vec2, c: Vec2) -> bool:
    # 对 CCW 三角形，点在三条边左侧或边上。
    eps = 1e-18
    return cross2(a, b, p) >= -eps and cross2(b, c, p) >= -eps and cross2(c, a, p) >= -eps


def v_sub(a: Vec3, b: Vec3) -> Vec3:
    return a[0] - b[0], a[1] - b[1], a[2] - b[2]


def v_cross(a: Vec3, b: Vec3) -> Vec3:
    return (
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    )


def v_normalize(v: Vec3) -> Vec3:
    length = math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2])
    if length <= 1e-20:
        return 0.0, 0.0, 1.0
    return v[0] / length, v[1] / length, v[2] / length


def triangle_normal(a: Vec3, b: Vec3, c: Vec3) -> Vec3:
    return v_normalize(v_cross(v_sub(b, a), v_sub(c, a)))


def desired_to_gltf_y_up(v: Vec3) -> Vec3:
    """3D Tiles b3dm 中 glTF 默认 y-up，运行时会转为 z-up。

    我们的目标坐标是 ECEF-relative desired=(x,y,z)。
    为了经过 y-up -> z-up 旋转后仍得到 desired，需要写入 inverse 旋转: (x,z,-y)。
    """
    return v[0], v[2], -v[1]


# -----------------------------------------------------------------------------
# CRS / tiling
# -----------------------------------------------------------------------------


def geodetic_to_ecef(lon_deg: float, lat_deg: float, h: float = 0.0) -> Vec3:
    lon = math.radians(lon_deg)
    lat = math.radians(lat_deg)
    sin_lat = math.sin(lat)
    cos_lat = math.cos(lat)
    sin_lon = math.sin(lon)
    cos_lon = math.cos(lon)

    n = WGS84_A / math.sqrt(1.0 - WGS84_E2 * sin_lat * sin_lat)
    x = (n + h) * cos_lat * cos_lon
    y = (n + h) * cos_lat * sin_lon
    z = (n * (1.0 - WGS84_E2) + h) * sin_lat
    return x, y, z


def lonlat_to_tile(lon: float, lat: float, z: int) -> Tuple[int, int]:
    lat = clamp(lat, -WEB_MERCATOR_MAX_LAT, WEB_MERCATOR_MAX_LAT)
    n = 2 ** z
    x = int((lon + 180.0) / 360.0 * n)
    lat_rad = math.radians(lat)
    y = int((1.0 - math.asinh(math.tan(lat_rad)) / math.pi) / 2.0 * n)
    return int(clamp(x, 0, n - 1)), int(clamp(y, 0, n - 1))


def clamp(v: float, low: float, high: float) -> float:
    return max(low, min(high, v))


# -----------------------------------------------------------------------------
# GLB / B3DM writers
# -----------------------------------------------------------------------------


def make_glb(positions_desired: List[Vec3], normals_desired: List[Vec3], color: Tuple[float, float, float, float]) -> bytes:
    if len(positions_desired) != len(normals_desired):
        raise ValueError("positions 和 normals 数量不一致。")
    if not positions_desired:
        raise ValueError("空 geometry，无法生成 glb。")

    positions = [desired_to_gltf_y_up(p) for p in positions_desired]
    normals = [desired_to_gltf_y_up(n) for n in normals_desired]

    pos_min = [min(p[i] for p in positions) for i in range(3)]
    pos_max = [max(p[i] for p in positions) for i in range(3)]

    pos_bytes = pack_float_vec3(positions)
    pos_pad = pad_len(len(pos_bytes), 4)
    norm_offset = len(pos_bytes) + pos_pad
    norm_bytes = pack_float_vec3(normals)
    bin_blob = pos_bytes + (b"\x00" * pos_pad) + norm_bytes
    bin_blob += b"\x00" * pad_len(len(bin_blob), 4)

    gltf = {
        "asset": {"version": "2.0", "generator": "shp_to_3dtiles.py"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"mesh": 0}],
        "meshes": [
            {
                "primitives": [
                    {
                        "attributes": {"POSITION": 0, "NORMAL": 1},
                        "material": 0,
                        "mode": GL_TRIANGLES,
                    }
                ]
            }
        ],
        "materials": [
            {
                "pbrMetallicRoughness": {
                    "baseColorFactor": [round(color[0], 6), round(color[1], 6), round(color[2], 6), round(color[3], 6)],
                    "metallicFactor": 0.0,
                    "roughnessFactor": 1.0,
                },
                "doubleSided": False,
            }
        ],
        "buffers": [{"byteLength": len(bin_blob)}],
        "bufferViews": [
            {
                "buffer": 0,
                "byteOffset": 0,
                "byteLength": len(pos_bytes),
                "byteStride": 12,
                "target": GL_ARRAY_BUFFER,
            },
            {
                "buffer": 0,
                "byteOffset": norm_offset,
                "byteLength": len(norm_bytes),
                "byteStride": 12,
                "target": GL_ARRAY_BUFFER,
            },
        ],
        "accessors": [
            {
                "bufferView": 0,
                "componentType": GL_FLOAT,
                "count": len(positions),
                "type": "VEC3",
                "min": [round(v, 6) for v in pos_min],
                "max": [round(v, 6) for v in pos_max],
            },
            {
                "bufferView": 1,
                "componentType": GL_FLOAT,
                "count": len(normals),
                "type": "VEC3",
            },
        ],
    }

    json_bytes = json.dumps(gltf, separators=(",", ":")).encode("utf-8")
    json_bytes += b" " * pad_len(len(json_bytes), 4)

    total_len = 12 + 8 + len(json_bytes) + 8 + len(bin_blob)
    header = struct.pack("<III", 0x46546C67, 2, total_len)  # magic 'glTF'
    json_header = struct.pack("<II", len(json_bytes), 0x4E4F534A)  # JSON
    bin_header = struct.pack("<II", len(bin_blob), 0x004E4942)  # BIN\0
    return header + json_header + json_bytes + bin_header + bin_blob


def pack_float_vec3(values: Sequence[Vec3]) -> bytes:
    arr = array.array("f")
    for x, y, z in values:
        arr.extend((float(x), float(y), float(z)))
    if sys.byteorder != "little":
        arr.byteswap()
    return arr.tobytes()


def make_b3dm(glb: bytes, rtc_center: Vec3) -> bytes:
    feature_table = {
        "BATCH_LENGTH": 0,
        "RTC_CENTER": [round(rtc_center[0], 6), round(rtc_center[1], 6), round(rtc_center[2], 6)],
    }
    ft_json = json.dumps(feature_table, separators=(",", ":")).encode("utf-8")
    # b3dm header 28 bytes，要求 binary glTF 从 8-byte boundary 开始。
    ft_json += b" " * pad_len(28 + len(ft_json), 8)

    batch_json = b""
    batch_bin = b""
    ft_bin = b""

    tile = build_b3dm_blob(ft_json, ft_bin, batch_json, batch_bin, glb)
    # b3dm byteLength 也要求 8-byte aligned；glb 的真实 length 在 GLB header 中，尾部 padding 可被客户端忽略。
    end_pad = pad_len(len(tile), 8)
    if end_pad:
        tile += b"\x00" * end_pad
        tile = build_b3dm_blob(ft_json, ft_bin, batch_json, batch_bin, glb + b"\x00" * end_pad)
    return tile


def build_b3dm_blob(ft_json: bytes, ft_bin: bytes, batch_json: bytes, batch_bin: bytes, glb: bytes) -> bytes:
    byte_length = 28 + len(ft_json) + len(ft_bin) + len(batch_json) + len(batch_bin) + len(glb)
    header = struct.pack(
        "<4sIIIIII",
        b"b3dm",
        1,
        byte_length,
        len(ft_json),
        len(ft_bin),
        len(batch_json),
        len(batch_bin),
    )
    return header + ft_json + ft_bin + batch_json + batch_bin + glb


def pad_len(current_len: int, alignment: int) -> int:
    r = current_len % alignment
    return 0 if r == 0 else alignment - r


# -----------------------------------------------------------------------------
# Mesh building
# -----------------------------------------------------------------------------


def build_tile_mesh(tile: TileBucket, transformer: CoordinateTransformer, rtc_center: Vec3) -> Tuple[List[Vec3], List[Vec3]]:
    positions: List[Vec3] = []
    normals: List[Vec3] = []

    def local_ecef(lon: float, lat: float, h: float) -> Vec3:
        e = transformer.lonlat_to_ecef(lon, lat, h)
        return e[0] - rtc_center[0], e[1] - rtc_center[1], e[2] - rtc_center[2]

    def add_tri(a: Vec3, b: Vec3, c: Vec3) -> None:
        n = triangle_normal(a, b, c)
        positions.extend((a, b, c))
        normals.extend((n, n, n))

    for feature in tile.features:
        for ring in feature.rings_ll:
            ring = clean_ring(ring)
            if len(ring) < 3 or abs(signed_area_2d(ring)) <= 1e-20:
                continue

            ring_ccw = ensure_ccw(ring)
            tris = triangulate_ear_clip(ring_ccw)
            if not tris:
                continue

            bottom = [local_ecef(lon, lat, feature.base_height) for lon, lat in ring_ccw]
            top = [local_ecef(lon, lat, feature.height) for lon, lat in ring_ccw]

            # 顶面：CCW，法线朝外/朝上。
            for i, j, k in tris:
                add_tri(top[i], top[j], top[k])

            # 底面：反向。
            for i, j, k in tris:
                add_tri(bottom[k], bottom[j], bottom[i])

            # 侧墙：对于 CCW 外环，[bottom_i, bottom_j, top_j] 朝外。
            n = len(ring_ccw)
            for i in range(n):
                j = (i + 1) % n
                bi = bottom[i]
                bj = bottom[j]
                ti = top[i]
                tj = top[j]
                add_tri(bi, bj, tj)
                add_tri(bi, tj, ti)

    return positions, normals


# -----------------------------------------------------------------------------
# Pipeline
# -----------------------------------------------------------------------------


def convert(args: argparse.Namespace) -> None:
    input_shp = Path(args.input_shp).resolve()
    output_dir = Path(args.output_dir).resolve()
    input_dbf = input_shp.with_suffix(".dbf")

    if not input_shp.exists():
        raise FileNotFoundError(f"找不到输入文件：{input_shp}")
    if input_shp.suffix.lower() != ".shp":
        raise ValueError("input_shp 必须是 .shp 文件。")

    if output_dir.exists():
        if args.overwrite:
            shutil.rmtree(output_dir)
        elif any(output_dir.iterdir()):
            raise FileExistsError(f"输出目录已存在且非空：{output_dir}。如需覆盖请加 --overwrite")
    output_dir.mkdir(parents=True, exist_ok=True)
    tiles_root = output_dir / "Tiles"
    tiles_root.mkdir(parents=True, exist_ok=True)

    color = parse_color(args.color)
    transformer = CoordinateTransformer(args.input_crs)

    dbf_records = read_dbf(input_dbf, args.encoding, args.limit) if input_dbf.exists() else []
    height_field = args.height_field.lower() if args.height_field else None
    base_height_field = args.base_height_field.lower() if args.base_height_field else None

    buckets: Dict[Tuple[int, int, int], TileBucket] = {}
    total_shapes = 0
    total_features = 0
    skipped = 0

    for idx, shp_rec in enumerate(read_shp_polygons(input_shp, args.limit)):
        total_shapes += 1
        attrs = dbf_records[idx] if idx < len(dbf_records) else {}
        if attrs.get("__deleted__") is True:
            skipped += 1
            continue

        exterior_input_rings = choose_exterior_rings(shp_rec.rings, args.outer_orientation)
        if not exterior_input_rings:
            skipped += 1
            continue

        exterior_ll_rings: List[List[Vec2]] = []
        for ring in exterior_input_rings:
            ring_ll = [transformer.to_lonlat(x, y) for x, y in ring]
            ring_ll = clean_ring(ring_ll)
            # 排除明显非经纬度或超出 WebMercator 的点。
            ring_ll = [(clamp(lon, -180.0, 180.0), clamp(lat, -89.999999, 89.999999)) for lon, lat in ring_ll]
            if len(ring_ll) >= 3 and abs(signed_area_2d(ring_ll)) > 1e-20:
                exterior_ll_rings.append(ring_ll)

        if not exterior_ll_rings:
            skipped += 1
            continue

        height = get_height(attrs, height_field, args.default_height)
        base_h = get_height(attrs, base_height_field, args.base_height) if base_height_field else float(args.base_height)
        if not math.isfinite(height):
            height = float(args.default_height)
        if not math.isfinite(base_h):
            base_h = 0.0
        if args.height_is_relative:
            top_h = base_h + max(float(height), 0.0)
        else:
            top_h = float(height)
        if top_h <= base_h + 0.01:
            top_h = base_h + max(float(args.default_height), 1.0)
        if args.min_height is not None and (top_h - base_h) < args.min_height:
            top_h = base_h + args.min_height
        if args.max_height is not None and (top_h - base_h) > args.max_height:
            top_h = base_h + args.max_height

        all_lons = [p[0] for r in exterior_ll_rings for p in r]
        all_lats = [p[1] for r in exterior_ll_rings for p in r]
        lon_min, lon_max = min(all_lons), max(all_lons)
        lat_min, lat_max = min(all_lats), max(all_lats)

        lon_c, lat_c = feature_centroid(exterior_ll_rings)
        tx, ty = lonlat_to_tile(lon_c, lat_c, args.lod)
        key = (args.lod, tx, ty)
        bucket = buckets.get(key)
        if bucket is None:
            bucket = TileBucket(z=args.lod, x=tx, y=ty)
            buckets[key] = bucket

        feature = Feature(
            rings_ll=exterior_ll_rings,
            height=top_h,
            base_height=base_h,
            lon_min=lon_min,
            lat_min=lat_min,
            lon_max=lon_max,
            lat_max=lat_max,
        )
        bucket.add_feature(feature)
        total_features += 1

    if not buckets:
        raise RuntimeError("没有生成任何瓦片：请检查 shp 类型、坐标系、height 字段或 limit。")

    children = []
    root_west = 180.0
    root_south = 90.0
    root_east = -180.0
    root_north = -90.0
    root_min_h = 0.0
    root_max_h = 0.0

    for key in sorted(buckets.keys()):
        tile = buckets[key]
        rtc_center = transformer.lonlat_to_ecef(
            (tile.west + tile.east) * 0.5,
            (tile.south + tile.north) * 0.5,
            (tile.min_h + tile.max_h) * 0.5,
        )

        positions, normals = build_tile_mesh(tile, transformer, rtc_center)
        if not positions:
            continue

        glb = make_glb(positions, normals, color)
        b3dm = make_b3dm(glb, rtc_center)

        tile_path = tiles_root / str(tile.z) / str(tile.x)
        tile_path.mkdir(parents=True, exist_ok=True)
        b3dm_path = tile_path / f"{tile.y}.b3dm"
        b3dm_path.write_bytes(b3dm)

        rel_uri = f"Tiles/{tile.z}/{tile.x}/{tile.y}.b3dm"
        region = region_radians(tile.west, tile.south, tile.east, tile.north, tile.min_h, tile.max_h)
        children.append(
            {
                "boundingVolume": {"region": region},
                "geometricError": 0,
                "content": {"uri": rel_uri},
            }
        )

        root_west = min(root_west, tile.west)
        root_south = min(root_south, tile.south)
        root_east = max(root_east, tile.east)
        root_north = max(root_north, tile.north)
        root_min_h = min(root_min_h, tile.min_h)
        root_max_h = max(root_max_h, tile.max_h)

    if not children:
        raise RuntimeError("瓦片分组成功，但所有瓦片 geometry 为空，未生成 b3dm。")

    tileset = {
        "asset": {"version": "1.0", "tilesetVersion": "1.0"},
        "geometricError": float(args.root_geometric_error),
        "root": {
            "boundingVolume": {
                "region": region_radians(root_west, root_south, root_east, root_north, root_min_h, root_max_h)
            },
            "geometricError": float(args.root_geometric_error),
            "refine": "ADD",
            "children": children,
        },
    }

    with (output_dir / "tileset.json").open("w", encoding="utf-8") as f:
        json.dump(tileset, f, ensure_ascii=False, indent=2 if args.pretty_json else None, separators=None if args.pretty_json else (",", ":"))

    print("Done.")
    print(f"  input shp        : {input_shp}")
    print(f"  output           : {output_dir}")
    print(f"  shapes read      : {total_shapes}")
    print(f"  features written : {total_features}")
    print(f"  skipped          : {skipped}")
    print(f"  tiles            : {len(children)}")
    print(f"  lod              : {args.lod}")


def feature_centroid(rings_ll: Sequence[Sequence[Vec2]]) -> Vec2:
    weighted_x = 0.0
    weighted_y = 0.0
    total_area = 0.0
    for ring in rings_ll:
        a = abs(signed_area_2d(ring))
        c = ring_centroid(ring)
        weighted_x += c[0] * a
        weighted_y += c[1] * a
        total_area += a
    if total_area > 1e-20:
        return weighted_x / total_area, weighted_y / total_area
    pts = [p for ring in rings_ll for p in ring]
    return sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts)


def get_height(attrs: Dict[str, object], field_lower: Optional[str], default: float) -> float:
    if not field_lower:
        return float(default)
    for k, v in attrs.items():
        if k.lower() == field_lower:
            if v is None:
                return float(default)
            if isinstance(v, (int, float)):
                return float(v)
            try:
                return float(str(v).strip().replace(",", ""))
            except Exception:
                return float(default)
    return float(default)


def region_radians(west: float, south: float, east: float, north: float, min_h: float, max_h: float) -> List[float]:
    # 3D Tiles region: [west, south, east, north, minHeight, maxHeight]，角度使用 radians。
    # 极小范围做一个微扩，避免某些 viewer 误判体积为 0。
    if abs(east - west) < 1e-12:
        east += 1e-9
        west -= 1e-9
    if abs(north - south) < 1e-12:
        north += 1e-9
        south -= 1e-9
    if max_h <= min_h:
        max_h = min_h + 1.0
    return [
        math.radians(west),
        math.radians(south),
        math.radians(east),
        math.radians(north),
        float(min_h),
        float(max_h),
    ]


def parse_color(value: str) -> Tuple[float, float, float, float]:
    s = value.strip()
    if s.startswith("#"):
        s = s[1:]
    if len(s) == 3:
        s = "".join(ch * 2 for ch in s)
    if len(s) not in (6, 8):
        raise ValueError("颜色格式应为 #RGB、#RRGGBB 或 #RRGGBBAA。")
    try:
        r = int(s[0:2], 16) / 255.0
        g = int(s[2:4], 16) / 255.0
        b = int(s[4:6], 16) / 255.0
        a = int(s[6:8], 16) / 255.0 if len(s) == 8 else 1.0
        return r, g, b, a
    except Exception as e:
        raise ValueError(f"无法解析颜色：{value}") from e


def build_arg_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="建筑物 Shapefile -> Cesium 3D Tiles b3dm 白模。纯 Python 解析 SHP/DBF，不依赖 pyshp/GDAL。"
    )
    p.add_argument("input_shp", help="输入 .shp 文件。旁边同名 .dbf 会自动读取。")
    p.add_argument("output_dir", help="输出目录。")
    p.add_argument("--lod", type=int, default=12, help="WebMercator 切片层级，默认 12。")
    p.add_argument("--limit", type=int, default=None, help="调试用：最多处理前 N 条 polygon。")
    p.add_argument("--color", default="#cccccc", help="白模颜色，默认 #cccccc。支持 #RGB/#RRGGBB/#RRGGBBAA。")
    p.add_argument("--height-field", default=None, help="建筑高度字段名；不指定则使用 --default-height。")
    p.add_argument("--base-height-field", default=None, help="底部高度字段名；不指定则使用 --base-height。")
    p.add_argument("--default-height", type=float, default=10.0, help="默认建筑高度，单位米，默认 10。")
    p.add_argument("--base-height", type=float, default=0.0, help="默认底部高度，单位米，默认 0。")
    p.add_argument(
        "--height-is-relative",
        action="store_true",
        help="把 height 字段解释为相对高度；topHeight = baseHeight + height。默认 height 字段视为绝对顶高。",
    )
    p.add_argument("--min-height", type=float, default=None, help="最小建筑相对高度，单位米。")
    p.add_argument("--max-height", type=float, default=None, help="最大建筑相对高度，单位米。")
    p.add_argument("--input-crs", default="EPSG:4326", help="输入 shp 坐标系，默认 EPSG:4326。投影坐标需安装 pyproj。")
    p.add_argument("--encoding", default="utf-8", help="DBF 字符编码，默认 utf-8；中文老数据可试 gbk。")
    p.add_argument(
        "--outer-orientation",
        choices=("auto", "cw", "ccw", "all"),
        default="auto",
        help="外环方向判断。auto=按面积主方向；cw=顺时针；ccw=逆时针；all=所有环都挤出。默认 auto。",
    )
    p.add_argument("--root-geometric-error", type=float, default=500.0, help="tileset root geometricError，默认 500。")
    p.add_argument("--overwrite", action="store_true", help="覆盖已存在输出目录。")
    p.add_argument("--pretty-json", action="store_true", help="格式化输出 tileset.json。")
    return p


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = build_arg_parser()
    args = parser.parse_args(argv)

    if args.lod < 0 or args.lod > 22:
        parser.error("--lod 建议在 0~22 之间。")
    if args.limit is not None and args.limit <= 0:
        parser.error("--limit 必须大于 0。")
    if args.default_height <= 0:
        parser.error("--default-height 必须大于 0。")

    try:
        convert(args)
        return 0
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
