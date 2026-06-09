# gis-read

当前版本：`1.0.7`

中文 | [English](./README.md)

`gis-read` 是一个基于 TypeScript 的 GIS 数据解析与转换工具，同时提供命令行 CLI 和 Node.js 库 API。它会把不同 GIS 格式统一解析为 GeoJSON 风格的 Feature，再写出为 GeoJSON、KML、GPX、ESRI JSON、CSV/WKT、Shapefile、MapInfo MIF 等常用交换格式。

## 功能特性

- 解析 Shapefile、MapInfo TAB、GeoJSON、KML、GPX、TopoJSON、CZML、CSV/WKT、ESRI JSON、MapInfo MIF、GeoPackage。
- 支持把输入格式转换为 GeoJSON、KML、GPX、ESRI JSON、CSV/WKT、Shapefile、MapInfo MIF、GeoPackage。MapInfo TAB 写出依赖本机安装 GDAL `ogr2ogr`。
- 支持大 GeoJSON 流式转换到 GeoJSON/KML/GPX，避免一次性加载完整文件。
- 支持从现有输入格式生成标准 XYZ Mapbox Vector Tile (`.pbf`) 矢量切片目录。
- 支持把矢量文件导入 PostgreSQL/PostGIS 或 SQL Server geometry 表，也支持把数据库空间表导出为矢量文件。
- Shapefile 的 DBF 属性表按记录读取，支持超过 2 GiB 的 DBF 文件，并会按 `.cpg` 或错误 `.cpg` 纠偏后的内容检测解码中文字段名。
- 保留常见元数据，例如 CRS、bbox、属性字段和格式相关 meta。
- 支持 WGS84、WebMercator、CGCS2000、GCJ-02、BD-09，以及 `EPSG:xxxx` 坐标转换。
- 自动识别常见中文 GIS 字段编码，包括 `.cpg`、TAB 头、合法 UTF-8 DBF 字节、dBASE language driver 和内容启发式探测；TAB 的 `Neutral` 字符集会按“未声明编码”处理并从文本字段探测。
- 支持 MapInfo TAB `WindowsSimpChinese` 字段名和属性值解码，并可读取常见 legacy 线对象、v500 `0x25` 点表线对象，以及 v300 压缩/未压缩 Region 坐标块几何。

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
npm install -g ./gis-read-1.0.7.tgz
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

# GeoPackage（多图层支持）
gis info input.gpkg                          # 查看所有图层
gis convert input.gpkg -o output.geojson     # 导出所有图层（每图层一个文件）
gis convert input.gpkg -o output.geojson --layer roads  # 导出指定图层
gis convert input.geojson -o output.gpkg     # 写出 GeoPackage

# 生成 MVT/PBF 矢量切片
gis tile input.shp -o tiles --min-zoom 8 --max-zoom 14
gis tile input.geojson -o tiles --from-crs WGS84 --threads 4 --layer buildings

# 数据库空间表导入/导出
gis db-import roads.shp --db postgresql --connection "$POSTGIS_URL" --srid 4326
gis db-import input.shp --db postgresql --connection "$POSTGIS_URL" --table public.roads --srid 4326
gis db-export --db sqlserver --connection "$MSSQL_URL" --table dbo.roads
gis db-export --db sqlserver --connection "$MSSQL_URL" --table dbo.roads -o roads.shp -t shapefile

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
| Shapefile | `.shp` + sidecars | 是 | 是 | DBF 属性不再一次性读入单个 Buffer，支持 `.cpg` 或纠偏后的 GBK/GB18030 内容检测解码中文字段名；写出 `.shp/.shx/.dbf/.cpg`，每个 bundle 只能包含一种几何族。 |
| MapInfo TAB | `.tab` + `.dat`/`.map`/`.id` | 是 | 是* | 写出需要 GDAL `ogr2ogr`；支持 TAB 字符集、中文属性值、常见 legacy 线对象、v500 `0x25` 点表线对象和 v300 压缩/未压缩 Region 坐标块读取，部分私有 `.map` 记录仍可能返回 `null`。 |
| GeoJSON | `.geojson`, `.json` | 是 | 是 | 支持流式输入和输出。 |
| KML | `.kml` | 是 | 是 | 支持 Placemark、ExtendedData、Point、LineString、Polygon、MultiGeometry。 |
| GPX | `.gpx` | 是 | 是 | 支持 waypoint 和 track/route；Polygon 输出会被跳过。 |
| TopoJSON | `.topojson` | 是 | 仅 GeoJSON | 展开共享 arcs 为普通坐标。 |
| CZML | `.czml` | 是 | 仅 GeoJSON | 将 entity packet 转为 Feature。 |
| CSV/WKT | `.csv` | 是 | 是 | 写出属性列和 `wkt` 几何列。 |
| ESRI JSON | `.json` | 是 | 是 | 读取/写出 ArcGIS 风格几何结构。 |
| MapInfo MIF | `.mif` + `.mid` | 是 | 是 | 写出文本 `.mif` 和属性 `.mid`。 |
| GeoPackage | `.gpkg` | 是 | 是 | 支持多图层；使用 `--layer` 选择指定图层，不指定时每个图层自动导出为单独文件。也支持读取 SpatiaLite `.sqlite` 文件。 |
| MVT/PBF tiles | `/{z}/{x}/{y}.pbf` | 否 | 是 | 通过 `gis tile` 生成，输入几何会统一转为 WebMercator。 |
| PostgreSQL/PostGIS | geometry 表 | 是 | 是 | 通过 `ST_AsBinary` / `ST_GeomFromWKB` 读写 WKB；连接来自 `--connection` 或 `GIS_READ_PG_CONNECTION`。 |
| SQL Server | geometry 表 | 是 | 是 | 通过 `STAsBinary()` / `geometry::STGeomFromWKB` 读写 WKB；连接来自 `--connection` 或 `GIS_READ_MSSQL_CONNECTION`。 |

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
  tileFile,
  writeVectorTiles,
  importFileToDatabase,
  exportDatabaseTable,
  transformFeatures,
  parseGeoPackage,
  parseGeoPackageLayers,
  writeGeoPackage,
  listGeoPackageLayers,
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

await tileFile('input.shp', {
  outputPath: 'tiles',
  minZoom: 8,
  maxZoom: 14,
  fromCrs: 'WGS84',
  threads: 4,
  layerName: 'buildings',
});

await importFileToDatabase('input.shp', {
  db: 'postgresql',
  connection: process.env.GIS_READ_PG_CONNECTION,
  table: 'public.roads', // 可选；省略时使用输入文件名去掉扩展名
  srid: 4326,
});

await exportDatabaseTable({
  db: 'sqlserver',
  connection: process.env.GIS_READ_MSSQL_CONNECTION,
  table: 'dbo.roads',
  outputPath: 'roads.geojson', // 可选；省略时使用 <table>.geojson
});

// GeoPackage：列出图层并读取指定图层
const layers = listGeoPackageLayers('input.gpkg');
console.log('图层:', layers);

const gpkg = parseGeoPackage('input.gpkg', { layer: 'roads' });
console.log(gpkg.features.length);

// GeoPackage：写出
writeGeoPackage(parsed, { outputPath: 'output.gpkg' });
```

流式读取 GeoJSON：

```ts
import { parseGeoJSONStream } from 'gis-read';

for await (const feature of parseGeoJSONStream('big.geojson')) {
  console.log(feature.properties);
}
```

读取超大 Shapefile 时，可以用 `parseShapefile('input.shp', { limit: 10 })` 只读取前几条 SHP/DBF 记录，先确认字段、编码和几何是否正常，再做完整转换。

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

测试覆盖 parser 行为、CLI 转换行为、矢量切片生成、数据库 SQL/WKB 行为、GeoJSON 流式处理、CRS 转换、编码检测和错误边界。设置 `GIS_READ_TEST_PG_CONNECTION` 后会额外运行真实 PostGIS 集成测试。

## 打包

npm 包只包含运行时所需文件：

- `dist/`
- `README.md`
- `read.md`
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
- Shapefile DBF 读取已绕开 Node 单个 Buffer 的 2 GiB 限制，但普通 `parse` 和 `convert` 仍会把返回的 features 放入内存。处理超大数据前建议先用 `gis parse input.shp --limit 10` 检查。
- 矢量切片当前只输出 XYZ `.pbf` 目录，不包含 MBTiles 或 GeoJSON tiles。
- 矢量切片会先把输入 features 解析到内存，再按 `--threads` 使用 worker 线程并行编码切片。
- 数据库导入会自动创建 geometry 表；如果目标表已存在会报错。省略 `--table` 时，默认使用输入文件名去掉扩展名作为表名；暂不支持 append/overwrite 或 geography 列。
- 导入属性列会清洗并按大小写不敏感规则去重；源字段 `ID` 如果和内部主键 `id` 冲突，会写为 `ID_1`。
- 数据库导出支持表名和可选 `--where`。省略 `--geom-column` 时会自动识别唯一的 `geometry` / `geography` 列；省略 `-o/--output` 时，默认写出 `<table>.geojson`；暂不支持任意 SQL 查询导出。
- 自动推导的数据库表名必须是合法标识符：可包含字母、数字、下划线，不能以数字开头；支持中文名，不支持空格和连字符。
- SQL Server 导入/导出依赖 `mssql` 包，并兼容 `mssql@11` 的 CommonJS 默认导出形态。旧版 SQL Server TLS 配置可在连接串中追加 `Encrypt=false`，或在服务器启用 TLS 1.2；`TrustServerCertificate=true` 只跳过证书校验，不会关闭加密。
- 编码识别可恢复 `.cpg` 错写 UTF-8、TAB `Neutral` 但实际为 GBK/GB18030 的属性文本。若源数据导出时已经把字符替换成字面量 `?`，或 DBF 11 字节字段名限制把中文截断到半个字符，工具无法反推出原字符。
- MapInfo TAB 写出委托给 GDAL `ogr2ogr`；未安装 GDAL 时请改写 MapInfo MIF。
- CSV 写出会把几何保存为单个 `wkt` 列。
- GPX 不能表达面几何，Polygon / MultiPolygon 输出会被跳过。
- KML 解析聚焦静态 Placemark 几何，不覆盖 NetworkLink、Region、LOD 等动态显示特性。
- GeoPackage 读取通过 sql.js（WASM）将整个文件加载到内存，超大文件可能占用较多 RAM。建议使用 `--layer` 按图层处理。每个 Feature 会添加 `_layer` 属性标记来源表名。
- 部分 MapInfo TAB `.map` 私有 record 类型可能返回 `geometry: null`，但属性仍会返回；常见 legacy 线对象和 v500 `0x25` 点表线对象会解析为 `LineString` 或 `MultiLineString`，v300 压缩/未压缩 Region 坐标块会解析为 `Polygon` 或 `MultiPolygon`。

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

## MapInfo TAB 几何兼容说明

当前版本支持读取常见 MapInfo TAB legacy 线对象、v500 `0x25` 点表线对象，以及 v300 压缩/未压缩 Region 坐标块记录。线对象会输出为 `LineString` / `MultiLineString`，Region 会输出为 `Polygon` / `MultiPolygon`。少数未识别的私有 `.map` record 仍可能返回 `geometry: null`，但属性字段会继续保留。

## License

MIT
