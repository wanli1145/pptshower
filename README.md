# pptshower

用于课堂展示的加密课件库。上传 PDF 后，在浏览器里输入总口令即可逐页展示。使用原生 HTML、CSS 和 JavaScript，无构建步骤；可部署到 GitHub Pages 等静态托管服务。

## 本地运行

```sh
python3 -m http.server 8765 --bind 127.0.0.1
```

打开 <http://127.0.0.1:8765/>。Web Crypto 需要 HTTPS 或 localhost，不建议直接双击 HTML 文件。

首次使用且站点尚未初始化时，首页显示「创建课件空间」，引导进入 `/admin/` 连接 GitHub 仓库、设置至少 12 个字符的总口令，再上传第一套课件。已经初始化的站点使用管理员统一设置的总口令，首页提供「第一次访问，还没有口令？」说明。生产管理台会实际写入 GitHub；仅查看界面可以直接打开，无需填写令牌。

仓库目标目前在 `admin/admin.js` 中配置为 `wanli1145/pptshower`、`main` 分支。Fork 后需同时更新配置和管理台的仓库说明。GitHub Pages 需要自行启用；保存成功表示 Git 提交完成，公开站点可能需要等待部署完成。

## 功能

- 总口令解锁；课件内容、标题和日期均加密保存。
- 按标题搜索，按日期或标题排序，网格和列表视图切换。
- 自适应 PDF 展示、缩略图总览、PDF 链接、全屏与触屏滑动。
- 管理台支持上传、编辑标题和日期、替换 PDF、删除课件。
- PDF.js 在首次打开课件时加载，首页不加载 PDF 渲染依赖。

快捷键：方向键 / PageUp / PageDown 翻页；空格下一页，Shift + 空格上一页；Home / End 首末页；F 全屏；G 总览；Esc 关闭总览。

## 数据与保存

- `site.json`：公开的 KDF 参数与随机盐。
- `decks/index.enc`：加密的课件索引。
- `decks/<id>/slides.pdf.enc`：加密的 PDF。
- 加密使用 PBKDF2-SHA-256（默认 600,000 次）与 AES-256-GCM；总口令不持久保存。
- GitHub 令牌保存在当前浏览器的 localStorage，点击「断开连接」清除。
- 管理台从固定 Git 提交读取配置和索引，保存时只允许基于该版本更新。其他页面有新提交时会拒绝保存，需刷新并重新解锁；不自动覆盖旧索引。
- 忘记总口令无法恢复课件。删除仅从当前分支内容中移除，Git 历史中仍可能保留旧的加密文件。

## 验证与隔离预览

需要 Node.js 22 或更新版本，无需安装 npm 依赖。

```sh
node --test tests/repository.test.mjs
node tests/preview-server.mjs
```

隔离预览地址：<http://127.0.0.1:8788/>，总口令 `preview-only-2026`，管理台令牌 `preview-token`。

预览服务使用内存中的模拟仓库、六套示例课件和三页示例 PDF。所有修改仅在进程内存中生效，重启后重置，不请求真实 GitHub，也不会生成生产课件文件。不要将该开发服务器用于公开部署。

可以使用 `PPTSHOWER_PREVIEW_PORT=8789 node tests/preview-server.mjs --empty` 检查首次设置流程，或使用 `--config-error` 检查配置读取失败。测试服务不会将缺失的模拟课件回退到磁盘中的正式课件。

`/tests/responsive.html` 提供 390px 宽的 iframe，方便检查响应式布局；它不等同于真实手机的触控、浏览器和全屏兼容性测试。

## 设计参考

参考 [Tabler](https://preview.tabler.io/) 的工作空间布局与表单层级，以及 [shadcn Authentication](https://ui.shadcn.com/examples/authentication) 的分栏认证结构。实现为项目自有的原生 HTML/CSS，没有引入上述框架或复制模板源码。

详细设计取舍见 [docs/ui-design.md](docs/ui-design.md)。
