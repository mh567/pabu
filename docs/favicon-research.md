# 导航与书签产品的网站图标实现调研

调研日期：2026-11-11。以项目官方文档和公开源码为依据，区分图标展示地址、抓取端和缓存端。

## 调研结果

| 产品 | 图标来源与抓取位置 | 缓存方式 | 观察到的限制 |
|---|---|---|---|
| Homarr | [官方图标文档](https://homarr.dev/docs/advanced/icons/)说明图标库索引由服务端启动及每周刷新。网站图标建议只在图标选择器打开时由服务端读取 `<link rel=icon>`、`apple-touch-icon`，失败回退同源 `/favicon.ico`。 | 图标库索引保留上次缓存，GitHub 限流或响应异常不会清除已有条目。选择器的来源建议按用户选择；文档没有说明具体磁盘缓存介质。 | 网站建议只用于选择器首条建议，不自动替用户覆盖选择。仍受目标站访问限制。 |
| Homepage | [书签项源码](https://github.com/gethomepage/homepage/blob/dev/src/components/bookmarks/item.jsx)展示配置中的 `bookmark.icon`。[ResolvedIcon 源码](https://github.com/gethomepage/homepage/blob/dev/src/components/resolvedicon.jsx)把 URL 图标直接交给浏览器图片组件，也支持 jsDelivr 图标库。 | 这两处源码未显示为每个书签自动抓取网页图标或自行持久化缓存。外部 URL 的 HTTP 缓存由浏览器和源站决定。 | 官网服务图标与用户书签 URL 图标属配置值；从检查的代码不能推断 Homepage 对任意书签自动发现 favicon。 |
| Linkwarden | [LinkIcon](https://github.com/linkwarden/linkwarden/blob/main/apps/web/components/LinkViews/LinkComponents/LinkIcon.tsx)将链接 origin 交给同源 `/api/v1/getFavicon`。服务端 [getFavicon](https://github.com/linkwarden/linkwarden/blob/main/apps/web/pages/api/v1/getFavicon/index.ts)先请求 Google favicon 服务，再请求 DuckDuckGo favicon 服务。 | HTTP 响应头设置浏览器缓存一天、共享缓存 30 天，并允许 stale-while-revalidate。这里提供缓存响应头，实际共享缓存效果取决于部署代理/CDN。 | 依赖第三方 favicon 聚合服务，不从目标站 HTML 抓取。目标图标未被第三方收录或上游不可用时会返回 204。 |
| Dashy | [图标组件源码](https://raw.githubusercontent.com/Lissy93/dashy/master/src/components/LinkItems/ItemIcon.vue)用第三方 favicon API 拼接 hostname；内网或 local 地址直接尝试 `origin/favicon.ico`，图片失败时显示本地 fallback。[图标文档](https://docs.dashy.to/docs/icons/) | 展示端通过 `<img>` 请求；源码所示没有自建抓取或持久化缓存机制，HTTP 缓存交由浏览器及上游服务。 | 第三方 API 可受可用性、隐私策略限制；内网站点仅试标准路径，无法从网页声明中探索图标。 |
| Bonjourr | [Quick Links 文档](https://bonjourr.fr/docs/widgets/quick-links/)说明自动使用其 favicon-fetcher；自定义图片直接引用图片 URL。 | 文档称自动 favicon 在浏览器缓存一年；自定义图像缓存依赖图片源站。 | 公共 favicon-fetcher 是额外服务依赖。 |
| Chrome 扩展 | [Chrome 官方文档](https://developer.chrome.com/docs/extensions/how-to/ui/favicons)要求扩展申请 `favicon` 权限，再用 `chrome-extension://<id>/_favicon/` URL 显示网站 favicon。浏览器负责解析和提供 favicon。 | 文档未给扩展自行复制图片到 IndexedDB 或其私有存储的要求。实际缓存由 Chrome favicon 服务维护。 | 该 API 仅供扩展上下文使用，普通网页无法调用；因此不能直接移植到自托管导航页。 |

## 对 Pabu 的启示

行业做法并不统一为“浏览器端自动抓网页并永久缓存”。浏览器端显示 `<img>` 很常见，但自动发现通常交给浏览器扩展 API、站点服务器、公共 favicon API，或让用户选图。普通网页端受同源策略限制，无法读取大多数外站 HTML，因此直接端侧抓取并不能普遍提高发现率。

适合 Pabu 的折中方案是：浏览器负责图片加载和 HTTP 缓存，Pabu 服务端按需发现并缓存成功图标；内网地址优先尝试原始图片地址或 `/favicon.ico`，且应允许用户指定图标 URL。对拒绝服务端访问的站点，浏览器直接显示其已知图标图片 URL可作为补充，但无法解析跨域 HTML。刷新时先复用浏览器缓存和已成功的服务端缓存，避免全量重新抓取。

当前研究未逐一核实各产品所有缓存层的底层介质；文中对未明确的内容已标出，不作推断。
