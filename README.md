# ryten-plugins

RytenBench 的**独立插件**仓库：这些插件不属于应用本体，通过 GitHub Release 资产分发，
用户在 RytenBench 的「设置 → 插件 → 从 GitHub 安装」里一键装（或自己选目录安装）。

| 插件 | 目录 | id | 说明 |
| --- | --- | --- | --- |
| 任务规划 | `plugins/task-planner` | `task-planner` | 任务树 / 甘特图 / 列表视图 + 依赖关系，并给 AI 提供 `manage_planner` 工具 |
| 音乐播放器 | `plugins/music-player` | `music-player` | 歌单 / 曲目 / 封面 / 迷你播放器与底栏条目，并给 AI 提供 `manage_music` 工具 |

## 插件包长什么样

每个插件构建成一个小目录（`dist/<id>/`）+ 一个 zip（Release 资产）：

```
plugin.json      清单（由 manifest.ts 生成，id/名称/版本/routes/menu/entry）
main.cjs         主进程入口（CJS，导出 install(ctx)）
renderer.mjs     渲染层入口（ESM，宿主用 blob import 加载）
chunk-*.mjs      渲染层的按需 chunk（懒加载视图等）
```

**插件包里没有 React / PGlite / antd 的第二份拷贝**：源码里的 `@host/**` 说明符在构建时被
换成宿主运行时调用（主进程 `globalThis.__RB_HOST_RESOLVE__`、渲染层 `plugin://host/ui.js` 桥），
运行期由 RytenBench 注入它自己的那一份实例（单例、主题、i18n 都保持一致）。
契约面清单见 RytenBench 的 `src/plugins/PACKAGING.md`；本仓库用 `host.d.ts` 声明这些 API。

## 开发

```bash
npm install
npm run build        # 产出 dist/<id>/ 与 dist/<id>-<version>.zip，并刷新 plugins.json
npm run build:dev    # 不压缩 + inline sourcemap（本地调试用，体积大很多）
npm run typecheck    # tsc --noEmit（host.d.ts 是宿主 API 的类型声明）
```

调试整套「下载 → 安装 → 装载」链路时，可以本地起一个 fixture 服务器代替 GitHub：

```bash
npm run build
npm run fixture              # http://127.0.0.1:8799 暴露 plugins.json 与 zip
# 然后在 RytenBench 里把插件源指向它（应用侧 env：RB_PLUGINS_REPO=http://127.0.0.1:8799）
```

## 发布

推一个 tag 即可（`.github/workflows/release.yml`）：

```bash
git tag v0.1.0 && git push origin v0.1.0
```

CI 会：`npm install` → `node scripts/build.mjs --tag v0.1.0` → 建 Release 并上传 `dist/*.zip`
→ 把带 tag 的 `plugins.json` 提交回 `main`。

**索引与应用的关系**：应用只读 `main` 分支的 `plugins.json`（不需要 GitHub API / token），
按里面的 `asset` 去 `releases/download/<tag>/<asset>` 下载，并用 `sha256` 校验完整性。
所以**索引与 Release 必须同步**（CI 就是这么做的）；手工发布时记得也更新 `plugins.json`。

## 目录结构

```
plugins/<id>/manifest.ts        清单（单一真源：id/名称/版本/routes/menu）
plugins/<id>/main/index.ts      主进程入口：install(ctx)（注册 IPC / 贡献 AI 工具 / purge）
plugins/<id>/main/db/           自带表结构：schema.ts（drizzle 表对象）+ ddl.ts（幂等建表）
plugins/<id>/main/ipc.ts        该插件的 IPC 通道（`plugin:<id>:*`）
plugins/<id>/renderer/plugin.tsx 渲染层入口：注册路由 / 菜单 / 设置页 / Provider / 底栏
plugins/<id>/locales/           该插件自己的词条（含侧栏菜单文案，不再借用宿主的 shell.*）
plugins/<id>/types/             宿主契约的类型声明副本（插件契约 + 用到的设置字段）
```

两条硬约定：

1. **表结构归插件自己**：`main/db/ddl.ts` 在装载时幂等建表（`CREATE TABLE IF NOT EXISTS`），
   宿主的 drizzle 迁移里没有这两张表；mapper / purge 都先 `await schemaReady`。
   因此卸载插件不会删表结构，重装后数据照旧（升级/老库同样安全）。
2. **只碰自己的东西**：付费/用户数据在宿主库里，插件只删自己建的行与自己的托管目录
   （`plugin.purge` 贡献里说明「会删什么」，宿主把它显示在卸载确认框里）。
