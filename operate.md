
node dist/cli.js parse F:\temp\地铁\微网格图层202604281600\微网格图层20260428_阿坝.gpkg --limit 50

node dist/cli.js db-import F:\temp\地铁\微网格图层202604281600\微网格图层20260428_阿坝.gpkg --db postgresql --connection "postgres://postgres:postgis@localhost:5432/postgis"


node dist/cli.js db-export --db postgresql --connection "postgres://postgres:postgis@localhost:5432/postgis"  --table public.lakes -o lakes.gpkg

node dist/cli.js convert data/lakes.shp -o output/lakes.tab


node dist/cli.js  terrain data/sc_dem_tif.tif -o output/terrain --max-zoom 12
node dist/cli.js  terrain-cesium data/sc_dem_tif.tif -o output/terrain --max-zoom 12

node dist/cli.js 3dtiles data/building.shp -o output/3dtiles --height HEIGHT --max-zoom 12

node dist/cli.js convert data/lakes.shp -o output/lakes.fg

node dist/cli.js 3dtiles building.shp -o output/3dtiles --height HEIGHT

node dist/cli.js 3dtiles building.shp -o output/3dtiles --height HEIGHT --dem dem.tif --color "#FFE4B5"

node dist/cli.js serve output/3dtiles              # 默认端口 8080
node dist/cli.js serve output/terrain --port 3000  # 指定端口

git add .
git commit -m ""
git push origin main

npm login
npm publish --access public




全局修改版本号为1.0.9，更新操作手册和readme文档，最终推送至git和npm