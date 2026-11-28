# Cloudflare 部署

目标为 Workers Static Assets：所有扫描、解析、优化、执行和笔记都在浏览器中完成，没有 Worker 请求处理代码、绑定、账号系统或数据库。配置与同级 `transformer-animation` 一致，但不加载访问统计脚本（见下文）。

## 发布

配置在 [`wrangler.jsonc`](../wrangler.jsonc)。`wrangler deploy` 先运行 `build.command`，即 `npm run build:deploy`（类型检查、单元测试、Vite 生产构建），任一步失败则不部署；成功后上传 `dist/` 中的静态资源。

本地检查部署配置（会构建，但不上传）：

```powershell
npm run deploy -- --dry-run
```

手动发布：

```powershell
npm run deploy
```

需要先 `npx wrangler login`。Windows 上请从大写盘符的目录（`D:\…`）运行：从小写 `d:\` 启动的 Vitest 会让所有测试文件报 `Cannot read properties of undefined (reading 'config')`，构建因此中止。

## 推送 main 自动部署（Workers Builds）

与兄弟项目相同，可在 Cloudflare 控制台把仓库连接到 Worker `compiler-principle`：Workers & Pages → `compiler-principle` → Settings → Build → Connect，选择 GitHub 仓库 `compiler-principle`、分支 `main`，构建命令留空，部署命令保持默认 `npx wrangler deploy`。之后每次推送到 `main`，Cloudflare 会执行 `npm clean-install` 与 `npx wrangler deploy`，按上面的流程检查、构建并发布。若 Cloudflare 的 GitHub App 只授权了部分仓库，需要先在 GitHub 中把本仓库加入授权。

`wrangler.jsonc` 中的 `name` 必须与控制台里连接的 Worker 名称一致，否则 Workers Builds 会报错。构建环境的 Node.js 版本由 [`.nvmrc`](../.nvmrc) 指定。

## 访问范围

- 公开：`workers_dev: true`，地址为 `https://compiler-principle.cjyhobbyprojects.workers.dev`，任何持有链接的人都可访问。分享链接因此可以直接发给别人。
- `preview_urls: false`：不生成版本预览 URL。
- 没有自定义域名或路由。
- 英文、德文页面是同一个 Worker 下的 `/en/…`、`/de/…` 路径，由 `not_found_handling: single-page-application` 回退到 `index.html`，不需要额外配置；实验仍由 `?lab=…` 选择，访问范围与中文页面相同。
- 改为私人访问时，在控制台 Worker → Settings → Domains & Routes → workers.dev 启用 Cloudflare Access；若以后添加自定义域名或预览 URL，也要分别加上相同的保护。

## 发布内容

- 只上传 `dist/`：构建产物与 `public/` 中的图标和汇编附录样例。`.cache/` 中的原书缓存、抓取元数据和私人笔记都不会打包或上传。
- 私人笔记仍只在访问者浏览器的 `localStorage` 中，不会发送到 Cloudflare。
- 不加载 Cloudflare Web Analytics 或其他统计脚本，来源页“访问节制与离线内容”的说明依赖这一点。若要像兄弟项目那样统计访问量，需要先在控制台 Web Analytics 中为上面的 workers.dev 主机名添加站点，再在 `vite.config.ts` 中仅为部署构建插入脚本，并同步修改该说明与 README。
- Workers & Pages → Worker → Metrics 只有原始请求数，每个 JS、CSS 文件都算一次，爬虫也计入，不区分页面和访客。

## 官方参考

- [Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/)
- [Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/)
- [Wrangler 配置](https://developers.cloudflare.com/workers/wrangler/configuration/)
- [workers.dev 路由与访问范围](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/)

核对日期：2026-11-28。
