
node dist/cli.js parse F:\temp\地铁\微网格图层202604281600\微网格图层20260428_阿坝.gpkg --limit 50

node dist/cli.js db-import F:\temp\地铁\微网格图层202604281600\微网格图层20260428_阿坝.gpkg --db postgresql --connection "postgres://postgres:postgis@localhost:5432/postgis"


node dist/cli.js db-export --db postgresql --connection "postgres://postgres:postgis@localhost:5432/postgis"  --table public.lakes -o lakes.gpkg

node dist/cli.js convert data/lakes.shp -o output/lakes.tab


node dist/cli.js  terrain data/sc_dem_tif.tif -o output/terrain --max-zoom 12

# 写出 GML
node dist/cli.js convert data/lakes.geojson -o output/output.gml

# 读取 GML
node dist/cli.js convert output/output.gml -o output/output.geojson

# 解析 GML
node dist/cli.js parse output/output.gml --limit 5

node dist/cli.js convert data/lakes.shp -o output/lakes.fg

node dist/cli.js serve output/terrain --port 9095  # 指定端口

python dem_to_terrain.py ../data/sc_dem_tif.tif ./tiles --max-level 10
python shp_to_3dtiles.py ../data/building.shp ./buildings --color "#cccccc" --height-field HEIGHT --limit 50000

python output/serve_terrain.py output/tiles --port 8080
node dist/cli.js serve output/tiles --port 8080

node dist/cli.js serve output/buildings --port 8080
python output/serve_terrain.py output/buildings --port 8080

python shp_to_3dtiles.py ../data/building.shp ./buildings --color "#cccccc" --height-field HEIGHT --limit 50000 --dem ../data/sc_dem_tif.tif

node dist/cli.js terrain-cesium data/sc_dem_tif.tif -o output/tiles --max-level 10
node dist/cli.js 3dtiles data/building.shp -o output/buildings --color "#cccccc" --height-field HEIGHT --limit 200000 --dem data/sc_dem_tif.tif

git add .
git commit -m ""
git push origin main

npm login
npm publish --access public




全局修改版本号为1.0.11，更新操作手册和readme文档，最终推送至git和npm