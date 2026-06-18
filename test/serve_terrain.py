"""
serve_terrain.py — 专用于 Cesium terrain 瓦片的本地 HTTP 服务器
自动设置正确的响应头，解决双重 gzip 和 CORS 问题

用法: python serve_terrain.py ./tiles [--port 8080]
"""
import argparse
import os
from http.server import HTTPServer, SimpleHTTPRequestHandler


class TerrainHandler(SimpleHTTPRequestHandler):

    def end_headers(self):
        # ── CORS（Cesium 跨域必须）
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")

        path = self.path.split("?")[0]

        if path.endswith(".terrain"):
            # ── .terrain 文件已经是 gzip 压缩的，必须声明
            self.send_header("Content-Encoding", "gzip")
            self.send_header("Content-Type", "application/octet-stream")

        elif path.endswith(".b3dm"):
            # ── .b3dm 文件是未压缩二进制（glTF payload），不要声明 gzip
            self.send_header("Content-Type", "application/octet-stream")

        elif path.endswith(".json"):
            self.send_header("Content-Type", "application/json; charset=utf-8")

        # 禁用缓存（开发调试时方便重新生成）
        self.send_header("Cache-Control", "no-cache, no-store")

        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()

    def log_message(self, fmt, *args):
        # 只打印 terrain 和 json 请求，过滤其他噪音
        msg = fmt % args
        if ".terrain" in msg or ".json" in msg or "404" in msg:
            print(f"  {self.address_string()}  {msg}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("directory", nargs="?", default=".",
                        help="瓦片目录（包含 layer.json）")
    parser.add_argument("--port", type=int, default=8080)
    args = parser.parse_args()

    os.chdir(args.directory)
    server = HTTPServer(("0.0.0.0", args.port), TerrainHandler)
    print(f"Terrain 服务启动: http://localhost:{args.port}")
    print(f"目录: {os.path.abspath(args.directory)}")
    print(f"Cesium 加载地址: http://localhost:{args.port}/layer.json")
    print("Ctrl+C 停止\n")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n服务已停止")


if __name__ == "__main__":
    main()
