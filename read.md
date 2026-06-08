# gis-read

中文 | [English](./README.md)

`gis-read` 是一个基于 TypeScript 的 GIS 数据解析与转换工具，同时提供命令行 CLI 和 Node.js 库 API。它会把不同 GIS 格式统一解析为 GeoJSON 风格的 Feature，再写出为 GeoJSON、KML、GPX、ESRI JSON、CSV/WKT、Shapefile、MapInfo MIF 等常用交换格式。

## 功能特性

- 解析 Shapefile、MapInfo TAB、GeoJSON、KML、GPX、TopoJSON、CZML、CSV/WKT、ESRI JSON、MapInfo MIF。
- 支持把输入格式转换为 GeoJSON、KML、GPX、ESRI JSON、CSV/WKT、Shapefile、MapInfo MIF。MapInfo TAB 写出依赖本机安装 GDAL `ogr2ogr`。
- 支持大 GeoJSON 流式转换到 GeoJSON/KML/GPX，避免一次性加载完整文件。
- 保留常见元数据，例如 CRS、bbox、属性字段和格式相关 meta。
- 支持 WGS84、WebMercator、CGCS2000、GCJ-02、BD-09，以及 `EPSG:xxxx` 坐标转换。
- 自动识别常见中文 GIS 字段编码，包括 `.cpg`、TAB 头、dBASE language driver 和内容启发式探测。
- 支持 MapInfo TAB `WindowsSimpChinese` 字段名和属性值解码，并可读取常见 legacy 线对象几何。

## 环境要求

- Node.js `>=18`
- 推荐 npm `>=8`

## 安装

发布到 npm 后全局安装：

```bash
npm install -g gis-read
gis --help
```

从本地 tarball 安装：

```bash
npm install -g ./gis-read-0.1.0.tgz
gis --help
```

在项目内安装：

```bash
npm install gis-read
npx gis --help
```

## CLI 快速开始

```bash
# 查看文件信息
gis info input.shp
gis detect input.kml

# 解析为 JSON 输出到 stdout
gis parse input.geojson --limit 5
gis parse input.geojson --no-pretty

# 格式转换
gis convert input.shp -o output.geojson
gis convert input.tab -o output.geojson
gis convert input.geojson -o output.kml
gis convert input.geojson -o output.esrijson -t esrijson
gis convert input.geojson -o output.csv
gis convert points.geojson -o points.shp -t shapefile
gis convert input.geojson -o output.mif
gis convert input.geojson -o output.tab -t tab # 需要 GDAL ogr2ogr

# 大 GeoJSON 流式转换
gis stream big.geojson -o big.kml
gis convert big.geojson -o big.geojson --stream

# GeoJSON 坐标转换
gis crs input.geojson --from WGS84 --to WebMercator -o output.geojson
gis crs-info BD09
```

如果是从源码运行：

```bash
npm install
npm run build
node dist/cli.js --help
```

## 支持格式

| 格式 | 扩展名 | 读取 | 写出 | 说明 |
| --- | --- | --- | --- | --- |
| Shapefile | `.shp` + sidecars | 是 | 是 | 写出 `.shp/.shx/.dbf/.cpg`；每个 bundle 只能包含一种几何族。 |
| MapInfo TAB | `.tab` + `.dat`/`.map`/`.id` | 是 | 是* | 写出需要 GDAL `ogr2ogr`；支持 TAB 字符集、中文属性值和常见 legacy 线对象读取，部分私有 `.map` 记录仍可能返回 `null`。 |
| GeoJSON | `.geojson`, `.json` | 是 | 是 | 支持流式输入和输出。 |
| KML | `.kml` | 是 | 是 | 支持 Placemark、ExtendedData、Point、LineString、Polygon、MultiGeometry。 |
| GPX | `.gpx` | 是 | 是 | 支持 waypoint 和 track/route；Polygon 输出会被跳过。 |
| TopoJSON | `.topojson` | 是 | 仅 GeoJSON | 展开共享 arcs 为普通坐标。 |
| CZML | `.czml` | 是 | 仅 GeoJSON | 将 entity packet 转为 Feature。 |
| CSV/WKT | `.csv` | 是 | 是 | 写出属性列和 `wkt` 几何列。 |
| ESRI JSON | `.json` | 是 | 是 | 读取/写出 ArcGIS 风格几何结构。 |
| MapInfo MIF | `.mif` + `.mid` | 是 | 是 | 写出文本 `.mif` 和属性 `.mid`。 |

## Node.js 库用法

```ts
import {
  parseFile,
  parseShapefile,
  parseGeoJSON,
  writeGeoJSON,
  writeKML,
  writeCSV,
  writeMIF,
  writeShapefile,
  writeFile,
  transformFeatures,
} from 'gis-read';

const parsed = parseFile('input.shp');
console.log(parsed.features.length);

const geojson = writeGeoJSON(parsed, { precision: 6 });
const kml = writeKML(parsed, { precision: 6 });
const csv = writeCSV(parsed, { precision: 6 });
writeMIF(parsed, { outputPath: 'output.mif', precision: 6 });
writeShapefile(parseFile('points.geojson'), { outputPath: 'points.shp' });
writeFile(parsed, 'output.csv', 'csv', { precision: 6 });

const manual = parseShapefile('input.shp');
transformFeatures(manual.features, 'WGS84', 'WebMercator');
```

流式读取 GeoJSON：

```ts
import { parseGeoJSONStream } from 'gis-read';

for await (const feature of parseGeoJSONStream('big.geojson')) {
  console.log(feature.properties);
}
```

主要返回结构：

```ts
interface ParseResult {
  name?: string;
  features: Feature[];
  crs?: CRS;
  bbox?: [number, number, number, number];
  meta?: Record<string, unknown>;
}
```

## 开发

```bash
npm install
npm test
npm run lint
npm run build
```

常用开发命令：

```bash
# 直接运行 TypeScript CLI
npm run dev -- info input.geojson

# 运行构建后的 CLI
npm start -- info input.geojson

# 生成 npm tarball
npm pack
```

测试覆盖 parser 行为、CLI 转换行为、GeoJSON 流式处理、CRS 转换、编码检测和错误边界。

## 打包

npm 包只包含运行时所需文件：

- `dist/`
- `README.md`
- `操作手册.md`
- `LICENSE`

大样例文件、生成输出、源码测试和开发 fixtures 不会进入发布包。`npm pack` 会通过 `prepack` 自动先执行 `npm run build`。

检查发布包内容：

```bash
npm pack --dry-run
```

发布到 npm：

```bash
npm publish --access public
```

源码仓库：<https://github.com/younggis/gis-read>

## 项目结构

```text
src/
  cli.ts                  CLI 入口
  index.ts                公共库导出入口
  crs.ts                  坐标系定义与转换
  encoding.ts             文本编码检测与解码
  format-detect.ts        格式识别
  parsers/                各格式 parser 和 writer
test/
  cli.test.ts             CLI 集成测试
  parsers.test.ts         Parser/writer/CRS/编码测试
  streaming.test.ts       流式解析、日志、错误边界测试
操作手册.md                 完整中文操作手册
```

## 已知限制

- Shapefile 写出要求同一个 bundle 只包含一种几何族；混合 Point/Line/Polygon 数据需要先拆分。
- MapInfo TAB 写出委托给 GDAL `ogr2ogr`；未安装 GDAL 时请改写 MapInfo MIF。
- CSV 写出会把几何保存为单个 `wkt` 列。
- GPX 不能表达面几何，Polygon / MultiPolygon 输出会被跳过。
- KML 解析聚焦静态 Placemark 几何，不覆盖 NetworkLink、Region、LOD 等动态显示特性。
- 部分 MapInfo TAB `.map` 私有 record 类型可能返回 `geometry: null`，但属性仍会返回；常见 legacy 线对象会解析为 `LineString` 或 `MultiLineString`。

## 贡献

新增格式、转换路径或 bugfix 应包含测试。提交 PR 前请运行：

```bash
npm test
npm run lint
npm run build
npm pack --dry-run
```

PR 描述中请说明影响的格式或 CLI 行为；如果行为变化明显，请附上示例命令或 fixture。

## 安全

请把 GIS 文件视为不可信输入。不要在高权限环境中处理来源不明的数据文件。不要提交 `.env`、日志、生成输出或大型本地样例数据。

## License

MIT
