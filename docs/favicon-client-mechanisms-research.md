# 导航产品端侧图标机制源码调研

调研日期：2026-11-12。范围：Dashy、Bonjourr、Homepage、Sun-Panel 四个开源产品，以及 Bonjourr 官方指向的 favicon-fetcher 库和 Chrome 官方扩展示例。仅写本文档，不修改产品代码，不安装依赖，不提交。

## 结论

这四个样本中的“端侧请求图标”包含不同责任：浏览器加载已知图片、浏览器向图标聚合服务请求、浏览器加载预置图标库，以及浏览器请求同源服务端抓取结果。最后都可以表现为图片元素，无法据此认定浏览器会读取目标网页 HTML 并自动发现图标，也无法据此推断全行业多数产品采用哪一种机制。

- Dashy 的 favicon 模式主要在浏览器拼接第三方服务地址；局域网或 local 模式拼接目标站 `/favicon.ico`。当前源码中第三方加载失败会再试目标站根图标，随后显示本地错误图标。[D1][D2]
- Bonjourr 自动模式把网站地址交给 `services.bonjourr.fr` 自建图标服务；官方关联的库会解析 HTML、manifest，并使用静态图标和 Google 回退。网页端没有因此获得跨域 HTML 读取能力。[B1][B2][B3][F1]
- Homepage 以配置图标为核心，支持直接 URL、本地路径和 jsDelivr 图标库；`next/image` 在本次提交中明确关闭优化，所以这些图片 URL 由浏览器直接加载。[H1][H2][H3]
- Sun-Panel 的“获取图标”按钮调用同源后端，后端解析 HTML、下载图标、落盘并返回本地文件路径。首页展示已保存的图片，获取和展示属于两个阶段。[S1][S2][S3][S4]
- 普通 `<img>` 可跨域展示已知图片，HTML 读取、像素读取、可用 Blob 提取分别受同源策略和 CORS 限制。Chrome 的 `/_favicon/` 服务要求扩展权限，普通网页不能直接调用该扩展 API。[W1][W2][W3][W4]

## 样本、版本与证据方法

通过 GitHub 仓库 API 确认默认分支、解析完整 commit，再请求该 commit 的递归文件树和源码归档。检查组件调用者、地址生成、失败处理、相关构建与缓存配置。下面的源码链接全部锁定 commit，避免后续默认分支变化影响引用。

| 产品或关联库 | 实际核实分支 | commit |
| --- | --- | --- |
| `Lissy93/dashy` | `master` | `305778b3b9393822da4346b64ba499d0fc839239` |
| `victrme/Bonjourr` | `master` | `f7add6fcba3861f94ad743230189fcc6a19e542d` |
| `gethomepage/homepage` | `dev` | `08a0c1df566464bfdb327f3fd8f1f5a058d56640` |
| `hslr-s/sun-panel` | `master` | `6119acf2258dd018dc18f68c1ce732b755b15e63` |
| `victrme/favicon-fetcher` | `main` | `c97c4d14d08db2850d86bcc4d17d0806b62797bf` |

这些提交代表本次访问时的分支快照，不代表所有历史版本或已部署版本。Homepage 本次检查的是其默认开发分支。Bonjourr 的公共服务没有向本次调研提供部署 commit，关联库的调用链与公共服务实际部署的一致性仍有限制。

## 四个产品的请求、回退与缓存摘要

| 产品 | 自动或配置图标实际请求方 | 网络失败处理 | 核实到的图片缓存 |
| --- | --- | --- | --- |
| Dashy | 浏览器请求聚合服务；local 直连目标根图标 | favicon 再试目标 `/favicon.ico`，仍失败显示本地错误 SVG | 外部图标依赖 HTTP 缓存；已查 SW 规则未覆盖外部 favicon 专用缓存 |
| Bonjourr | 浏览器请求 Bonjourr 外部自建服务；自定义 URL 直连 | 延迟重试，error 或超时改用服务的 error 图片 | 公共服务单样本 HTTP 七天；文档称一年；自动图标链未发现 Cache Storage/IDB 写入 |
| Homepage | 浏览器加载配置 URL 或图标 CDN，Next 优化关闭 | 未配置显示缩写；未发现已配置图片失败的应用级重试 | HTTP 缓存依来源；已查组件未显式持久化图片 |
| Sun-Panel | 编辑按钮请求后端抓取；展示请求已保存文件或手填 URL | 获取失败提示；未发现网络错误自动换供应商 | 服务端文件落盘与数据库引用；客户端 HTTP 策略未实测 |

详细调用链与对应来源见下文。

## 五种机制对照

| 机制 | 请求链与发现位置 | 本次样本 | 缓存含义 |
| --- | --- | --- | --- |
| ① 普通图片直连目标站 | 浏览器图片元素请求已知 URL，或程序猜测 `origin/favicon.ico`；此动作本身不读取 HTML | Dashy local 和 favicon 失败回退；Bonjourr、Homepage 自定义图片 URL；Sun-Panel 手填远程图片 | 通常受目标响应头、浏览器 HTTP 缓存和淘汰策略控制 |
| ② 浏览器请求第三方 favicon 聚合 | 浏览器请求 Google、DuckDuckGo、AllesEDV 等，服务商负责提供图标 | Dashy favicon 公网默认路径；Bonjourr 的自建服务也属于浏览器向外部图标服务请求 | 浏览器 HTTP 缓存来自图标服务；服务商内部抓取缓存需另查 |
| ③ 已配置或预置图标库/CDN | 根据图标名拼 CDN URL，或加载本地/打包图标 | Homepage 的 dashboard-icons、selfh.st、MDI、Simple Icons；Dashy 的多种图标模式 | 静态资源和 HTTP/CDN 缓存；通常无需访问书签目标站 |
| ④ 同源后端发现与抓取 | 浏览器请求本站 API，服务器读取目标 HTML、下载图片，再返回图片或本地路径 | Sun-Panel 获取图标；Pabu 当前公网路径 | 可有服务器落盘与应用缓存，和客户端 HTTP 缓存是不同层 |
| ⑤ 扩展 favicon API | 扩展构造 `chrome-extension://…/_favicon/?pageUrl=…&size=…` | Chrome 官方 MV3 示例；未把 Bonjourr 的自动图标归入此类 | Chrome 内部提供 favicon；不能据官方示例推断具体 TTL 或应用自行落盘 |

② 与④可以组合：一个服务可再调用另一个聚合服务。Bonjourr 的服务对 Bonjourr 网页属于跨域外部服务，不能称为该网页的同源代理；其服务内部仍承担服务器侧的发现和图片获取。

## Dashy：拼接聚合服务，失败再试根图标

实际调用链为 `ItemIcon.vue` 的 `getIconPath` → `getFavicon` → `iconPath` → `<img :src="iconPath" @error="onImageError">`。[D1]

1. 配置 `icon: favicon` 才选择 favicon 模式；`favicon-google`、`favicon-duckduckgo` 等可指定供应商。默认 `faviconApi` 为 `allesedv`。[D1][D2]
2. 公网模式用 `new URL(fullUrl).hostname` 提取主机，替换模板的 `$URL`，不把完整书签路径传给这些接口。模板包含：
   - `https://f1.allesedv.com/128/$URL`
   - `https://icons.duckduckgo.com/ip2/$URL.ico`
   - `https://www.google.com/s2/favicons?sz=128&domain_url=$URL`
3. `shouldUseDefaultFavicon` 的局域网正则命中，或选择 `local` 时，按 URL 的协议与主机拼 `${origin}/favicon.ico`。这是源码启发式，不能把该正则视为完备 IP 分类器。[D1]
4. `onImageError` 首次设置 `attemptedFallback`，favicon 类型的 `getFallbackIcon` 返回 local 路径；再次失败调用 `imageNotFound`，设置 `broken`，由本地 `BrokenImage` SVG 兜底。供应商返回 HTTP 200 的通用占位图片可能不触发图片错误事件，本链没有逐像素判定占位图。[D1]
5. 直接 URL、本地图标、`hl-`、`sh-`、字体和 emoji 各走独立分支。不能把这些成功加载都计为“自动发现网站 favicon”。[D1][D2]

缓存核实：图标组件没有写 Cache Storage 或 IndexedDB。进一步检查 `InitServiceWorker.js` 和 `vite.config.mjs`：SW 按配置启用，运行时缓存明确覆盖 YAML 配置，若干服务端端点走 NetworkOnly；在这些已检查路径中未发现外部 favicon 的专用运行时持久缓存规则。因此外部 favicon 主要可依赖浏览器 HTTP 缓存和供应商响应，具体 TTL 本次没有逐个测量。打包静态资源预缓存不能直接等同于远程 favicon 缓存。[D3][D4]

## Bonjourr：端侧请求其服务，发现工作在服务侧

实际调用链：`createElem`/文件夹渲染收集图标 → `getIconFromLinkElem` → `getDefaultIcon` → `createIcons` 设置 `img.src`。[B1][B2]

- 没有指定图标值时，`getIconFromLinkElem` 对合法链接取 `origin + pathname`，省略 query 与 fragment；`getDefaultIcon` 返回 `${API_DOMAIN}/favicon/blob/${url}`，`API_DOMAIN` 为 `https://services.bonjourr.fr`。该拼接保留嵌入路径的形式，没有把网站 URL 整体编码成一个查询参数。编辑更新路径也会直接把 `link.url` 传给 `getDefaultIcon`，不能把普通渲染时的 query 剔除推断为所有入口的统一隐私保证。[B1][B2][B3]
- `refreshIcons` 用 `?r=${Date.now()}` 改变图标 URL，达到客户端 HTTP 缓存换键效果；不等同于证明服务器重新抓取目标网页。[B1]
- 图片 400 毫秒后仍未完成或 `naturalWidth` 为零，会显示 loading 图并创建新图片重试；重试的 error 或五秒仍无响应时，显示 `https://services.bonjourr.fr/favicon/blob/error`。错误兜底也依赖服务网络。[B1]
- 自定义 URL 直接赋给图片；本地导入图片经压缩转 Data URI，写入 `storage.local` 的 `x-icon-<id>`。扩展走 `chrome.storage.local`，普通网页走 localStorage。这属于用户导入图标的显式存储，不能当作自动 favicon 的持久图片缓存。[B4][B5]
- 项目确有 `getCache` 封装，Safari 使用 IndexedDB 适配，其他平台使用 Cache Storage；本次追到的调用者是本地背景图功能，未发现其用于自动 quick-link favicon。Chrome manifest 只有 `storage` 和可选的书签等权限，没有 `favicon` 权限；检查到的自动图标链也没有使用 `/_favicon/`。[B6][B7]

### 官方关联 favicon-fetcher 的真实流程

官方 quick-links 文档直接链接 `victrme/favicon-fetcher`，核实该库的 `faviconAsFetch` → `faviconAsBlob` → `main` → `createFaviconList`、`fetchHtml`、`fetchManifest`、`fetchIcon`：[B8][F1][F2]

1. 先查静态图标映射，匹配则使用 `https://raw.githubusercontent.com/victrme/favicon-fetcher/main/package/icons/<文件>`。
2. 否则请求目标 HTML，解析 head 图标，并在有 manifest 时请求 manifest；按接近 144px 排序。重定向后更新解析基准。
3. 构造声明图标候选，再加入 `https://www.google.com/s2/favicons?domain=${origin}&sz=128`、`https://${host}/favicon.ico`、静态 `notfound.svg`。源码中 Google 地址的变量名叫 `duckduckgo`，应以 URL 判断实际供应商。
4. 默认 `check: best` 只验证排序后的首个声明图标，然后按回退顺序取图；`fetchIcon` 要求 HTTP 200，`main` 接受类型包含 image 的 Blob。不能把“解析所有候选”写成“默认逐个验证所有声明图标”。
5. `faviconAsFetch` 返回图片内容并设置 `Access-Control-Allow-Origin: *`。此流程若运行在服务端，可读取目标 HTML；库 README 的浏览器示例本身不能解除普通浏览器的 CORS 限制。[F1][F2]

### 一年缓存与七天响应头的差异

官方文档称自动图标在浏览器缓存一年，手填 URL 的缓存由目标站决定。[B8] 但本次锁定库代码实际设置 `Cache-Control: public, max-age=604800, immutable`，即七天。函数注释还有 30 天旧描述，应以代码为准。[F1]

另外实际 GET `https://services.bonjourr.fr/favicon/blob/https://example.com`，响应 Date 为 `Thu, 12 Nov 2026 14:14:26 GMT`，HTTP 200、`Content-Type: image/svg+xml`、`Cache-Control: public, max-age=604800, immutable`、`Access-Control-Allow-Origin: *`，图片体 2738 字节。该请求可直接复核，未鉴别其是否为站点专属图或通用占位图。当前单样本响应支持七天 HTTP 新鲜期；不能继续把一年当作本次已验证的现行响应值，也不能据此断言所有路由、地区节点都相同。未核实服务商内部 CDN、KV 或持久存储结构。

## Homepage：配置值解析成图片或 CSS mask

实际调用链：`bookmarks/item.jsx` 检查 `bookmark.icon` → `ResolvedIcon`；服务卡片也调用同一组件。[H1][H2]

| 图标配置 | 实际生成地址或行为 |
| --- | --- |
| `http…` 或 `/…` | 原样交给 Next Image |
| `sh-<name>` | `https://cdn.jsdelivr.net/gh/selfhst/icons@main/<svg或webp或png>/<name>.<扩展名>` |
| `mdi-<name>` | CSS mask：`https://cdn.jsdelivr.net/npm/@mdi/svg@latest/svg/<name>.svg` |
| `si-<name>` | CSS mask：`https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/<name>.svg` |
| 其他图标名 | `https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/<svg或webp或png>/<name>.<扩展名>` |
| 未配置 `bookmark.icon` | 显示 `bookmark.abbr` 文本 |

关键核实是 `next.config.js` 设置 `images.unoptimized: true`。仅看到 `next/image` 无法判断是否代理，本提交的配置支持直接加载原 URL 的结论。[H3]

`ResolvedIcon` 未传 `onError`，书签项在“配置缺失”时显示缩写；没有发现“已配置图标网络失败后自动换成缩写”的组件逻辑。源码注释中的 fallback 指图标命名分支的默认库，不能当成网络错误重试链。检查到的组件和配置没有自动读取书签 HTML，也没有将远程图标写 Cache Storage/IndexedDB，具体 HTTP TTL 依图片来源而异。`src/components/favicon.jsx` 绘制 Homepage 自身页签图标，不承担书签 favicon 发现职责。[H1][H2][H3][H4]

## Sun-Panel：编辑时由同源后端发现并保存

实际调用链：[S1][S2][S3][S4][S5]

1. 编辑窗口的按钮调用 `getIconByUrl(model.url, 0)`，或对 LAN URL 调用同函数。
2. 前端 `src/api/panel/itemIcon.ts` POST `/panel/itemIcon/getSiteFavicon`；标准后端总路由前缀为 `/api`，具体部署仍由前端 API baseURL 决定。该路由经过登录拦截。
3. Go `ItemIcon.GetSiteFavicon` 调用 `siteFavicon.GetOneFaviconURL`；后者请求 HTML，用 goquery 提取 `rel` 含 icon 的 link 并取第一个。绝对地址直接返回，其他路径用 `scheme://host/` 加裁去前导斜线的 href；此处未使用通用相对 URL 解析算法，不保证子目录相对图标解析正确。
4. handler 补协议后去掉图标 query，再 HEAD 检查远程文件大小，GET 下载图片，写入 `source_path/年/月/日/`；创建数据库文件记录，返回本地 `iconUrl`。
5. 前端设置 `model.icon = { itemType: 2, src: data.iconUrl }`。保存后，`ItemIcon/index.vue` 对 svg 用原生 img，对其他图片用 Naive UI `NImage`；上传目录由后端 Static 路由提供。

获取失败时前端显示获取失败提示，后端未发现声明图标时直接返回错误，本链没有根 `/favicon.ico` 自动回退，也没有 Google/DuckDuckGo 回退。仓库另有 `getFaviconUrl` 标准路径工具，但本次所追获取按钮并未调用它，不能把独立工具当作已接入的回退。[S1][S3][S4]

显示组件没有传应用级 `onError`、`error` 或 fallback-source；未配置图标时才显示空头像。`NImage` 内部错误展示未追至依赖源码，不能断言其内置具体图案；可以确认本组件没有实现第二供应商重试。[S6]

服务器落盘是取得图标后的资源保存，不等同于按 origin 去重、带 TTL 的共享抓取缓存。该 handler 用含时间的文件名并新建文件记录，未发现它按源站命中已有文件。浏览器后续访问本地图片仍可使用 HTTP 缓存；本链未设置专门图标 Cache Storage/IndexedDB，部署代理附加的缓存头未实测。[S3][S4][S5]

## 普通网页的能力边界

| 操作 | 普通网页可做的事 | 关键条件或限制 |
| --- | --- | --- |
| `<img src="https://other.example/icon.png">` | 通常可以展示已知跨域图片 | 仍可被 CSP、CORP、混合内容策略、服务端鉴权/防盗链或响应内容阻止；可展示不保证所有站点可嵌入 |
| `fetch(外站HTML)` 后 `response.text()` | 读取并解析页面声明 | 跨域需要 CORS 等许可；`mode: no-cors` 无法获得可读 HTML |
| 外站图画入 canvas 后读取像素/导出 | 经同源或正确 CORS 授权时可读 | 未获授权的跨域图片污染 canvas，`getImageData`、`toBlob`、`toDataURL` 会被拒绝 |
| `fetch(外站图片).blob()` 用于本机持久化 | 同源或获 CORS 许可后可提取可用图片 Blob | opaque 响应的 Blob 大小为 0、类型为空，不能当作正常图片 Blob 使用 |
| Cache Storage 保存 opaque 响应 | `Cache.put` 可以保存并由适当 SW 流程重放 | `Cache.add/addAll` 不接受此类非 2xx 可见响应；保存 opaque 仍不能读取/验证图片字节，也没有绕过 CORS |
| 调用 Chrome favicon 服务 | 拥有权限的扩展可构造内部 URL | 需 manifest 的 `favicon` 权限；若扩展主动声明可被网页访问的资源，页面可使用它暴露的资源，但普通网页自身仍没有该扩展 API |

依据为 MDN 同源策略、跨源 canvas、Response.blob、Cache.put，Chrome 官方 MV3 favicon 文档，以及 WHATWG Fetch 的 opaque response、CORS 和 CORP 规范。[W1][W2][W3][W4][W5][W6]

应区分三个缓存层：HTTP 缓存由浏览器按响应和请求语义维护；Cache Storage 是应用显式保存 Request/Response 的存储；IndexedDB 是应用显式结构化存储。HTTP max-age 与应用自行设置的 nextCheckAt 不可互相替代。存在通用缓存封装或 SW，不足以证明某种 favicon 已被持久化。

## 对 Pabu 的建议

以下是基于证据的建议，未授权或实施新功能。当前行为以本次读取的 `README.md`、`docs/architecture.md`、`docs/current-work.md`、`public/bookmark-icons.js` 和 `lib/icon-service.js` 为准。

1. **保留“显示”和“发现”的职责区分。** 已知准确图标地址可由浏览器加载；任意公网网站的 HTML 发现仍需当前受限服务端链路、明确选用的图标服务，或目标站主动提供 CORS。不能以样本的 img 直接证明普通网页可以普遍解析外站图标声明。
2. **先利用已有自定义图标地址处理非标准路径。** 父代理本轮提供的浏览器事实是：NodeSeek 的 `/static/image/favicon/favicon-32x32.png` 能在 Pabu 页面直接加载，根 favicon 失败。这支持“已知非根路径有用”，没有证明 Pabu 可跨域读取 NodeSeek HTML，也没有证明所有 NodeSeek 图片或客户端都可访问。本子任务未重复该浏览器实验。
3. **对 36kr 先保持诊断未完成的状态。** 父代理确认图标在 36kr 自身页面可加载，在 Pabu 跨站嵌入失败。可能涉及请求上下文、Referer、Cookie、CORP/CSP 或响应差异，但这些均是待排查方向。不能据此宣称某个具体反爬机制已被确认，也不能承诺端侧直连会解决。
4. **将第三方图标服务作为明确选择。** Dashy 与 Bonjourr 证明这条路径能简化客户端逻辑，也会将访客请求及目标站标识暴露给额外服务。Pabu 现有 `PABU_ICON_FALLBACK_PROVIDERS` 默认关闭应保持；本调研不构成默认开启、上传内网地址或上传完整签名 URL 的授权。
5. **继续区分图片持久化和地址记忆。** 当前 Pabu 公网同源 API 返回的可读图片进入 `pabu-bookmark-icons-v1`；跨域直连分支主要记录 src 并验证图片能否显示。只记地址无法保证离线图像可用，也不能把“没有 CORS”说成 Cache Storage 从平台能力上完全不能保存任何 opaque 响应。当前 Pabu 的 Blob 校验与字节限额路径需要可读响应，这是应用契约。
6. **无需照搬另一产品的宽松服务端抓取。** Sun-Panel 证实后端 HTML 发现加本地文件有效，但本次未对其 SSRF、大小限制完整性等进行安全审计。Pabu 既有公网 DNS/重定向检查、私网拒绝、共享 origin 缓存与隐私边界仍应保留。静态图标库也可作为用户选图思路，是否增加入口属于后续需求讨论。

## 局限与验证范围

- 四个产品属于定向样本，无法推断市场占比或“多数导航站”的实现。
- 源码调用链已实际访问并检查，未启动这些产品，也未对其进行跨浏览器、离线、缓存淘汰或私有部署验收。未测试供应商收录率和各地区可达性。
- “未发现”只覆盖文中组件、调用者和相关配置，不能据搜索无命中断言整个项目不存在其他功能。
- Bonjourr 公共服务仅对 example.com 路径测一次响应头；其文档一年和现行样本七天存在差异，已保留差异，未推断部署版本。
- NodeSeek、36kr 是父代理本轮传入的实验事实，未由本研究重新操作浏览器。36kr 失败根因仍未知。
- 本文不替换已有设计与计划，不新增功能授权，不更改任何导航、同步、分享或图标产品代码。

## 可直接引用的一手来源

### Dashy

[D1]: https://github.com/Lissy93/dashy/blob/305778b3b9393822da4346b64ba499d0fc839239/src/components/LinkItems/ItemIcon.vue
[D2]: https://github.com/Lissy93/dashy/blob/305778b3b9393822da4346b64ba499d0fc839239/src/utils/config/defaults.js
[D3]: https://github.com/Lissy93/dashy/blob/305778b3b9393822da4346b64ba499d0fc839239/src/utils/InitServiceWorker.js
[D4]: https://github.com/Lissy93/dashy/blob/305778b3b9393822da4346b64ba499d0fc839239/vite.config.mjs

- [D1 图标组件与错误回退][D1]：`src/components/LinkItems/ItemIcon.vue`，重点 L15、L162至205、L259至272。
- [D2 默认供应商与地址模板][D2]：`src/utils/config/defaults.js`，重点 L24、L187至213。
- [D3 SW 启用路径][D3]：`src/utils/InitServiceWorker.js`。
- [D4 Workbox 缓存配置][D4]：`vite.config.mjs`，重点 L71至104。

### Bonjourr 与 favicon-fetcher

[B1]: https://github.com/victrme/Bonjourr/blob/f7add6fcba3861f94ad743230189fcc6a19e542d/src/scripts/features/links/index.ts
[B2]: https://github.com/victrme/Bonjourr/blob/f7add6fcba3861f94ad743230189fcc6a19e542d/src/scripts/features/links/helpers.ts
[B3]: https://github.com/victrme/Bonjourr/blob/f7add6fcba3861f94ad743230189fcc6a19e542d/src/scripts/defaults.ts
[B4]: https://github.com/victrme/Bonjourr/blob/f7add6fcba3861f94ad743230189fcc6a19e542d/src/scripts/features/links/fileicons.ts
[B5]: https://github.com/victrme/Bonjourr/blob/f7add6fcba3861f94ad743230189fcc6a19e542d/src/scripts/storage.ts
[B6]: https://github.com/victrme/Bonjourr/blob/f7add6fcba3861f94ad743230189fcc6a19e542d/src/scripts/shared/cache.ts
[B7]: https://github.com/victrme/Bonjourr/blob/f7add6fcba3861f94ad743230189fcc6a19e542d/src/manifests/chrome.json
[B8]: https://bonjourr.fr/docs/widgets/quick-links/
[F1]: https://github.com/victrme/favicon-fetcher/blob/c97c4d14d08db2850d86bcc4d17d0806b62797bf/package/src/index.ts
[F2]: https://github.com/victrme/favicon-fetcher/blob/c97c4d14d08db2850d86bcc4d17d0806b62797bf/package/src/fetchers.ts

- [B1 渲染、失败和刷新][B1]：`src/scripts/features/links/index.ts`，重点 L317至363、L577至640、L807至825、L952至967。
- [B2 地址拼接][B2]：`src/scripts/features/links/helpers.ts` L8至14；[B3 服务域名][B3]：`src/scripts/defaults.ts` L13。
- [B4 导入图标存储][B4]：`src/scripts/features/links/fileicons.ts`；[B5 存储平台分支][B5]：`src/scripts/storage.ts` L214至234。
- [B6 Cache Storage 与 Safari IDB 适配][B6]：`src/scripts/shared/cache.ts`；背景图调用见同 commit 的 `src/scripts/features/backgrounds/local.ts` L784至833。
- [B7 Chrome 权限][B7]：`src/manifests/chrome.json`。
- [B8 官方 quick-links 与缓存说明][B8]：页面 Link icons、Cache policy on quick links icons 两节。
- [F1 发现、Google 回退与七天头][F1]：`package/src/index.ts`，重点 L105至147、L166至277。
- [F2 HTML/manifest/图片请求][F2]：`package/src/fetchers.ts`。
- 公共服务本次响应头取样 URL：https://services.bonjourr.fr/favicon/blob/https://example.com 。

### Homepage

[H1]: https://github.com/gethomepage/homepage/blob/08a0c1df566464bfdb327f3fd8f1f5a058d56640/src/components/bookmarks/item.jsx
[H2]: https://github.com/gethomepage/homepage/blob/08a0c1df566464bfdb327f3fd8f1f5a058d56640/src/components/resolvedicon.jsx
[H3]: https://github.com/gethomepage/homepage/blob/08a0c1df566464bfdb327f3fd8f1f5a058d56640/next.config.js
[H4]: https://github.com/gethomepage/homepage/blob/08a0c1df566464bfdb327f3fd8f1f5a058d56640/src/components/favicon.jsx

- [H1 书签调用与无图标缩写][H1]：`src/components/bookmarks/item.jsx`。
- [H2 图片/CDN/mask 解析][H2]：`src/components/resolvedicon.jsx` L11至153。
- [H3 关闭 Next 图片优化][H3]：`next.config.js`。
- [H4 产品自身页签图标][H4]：`src/components/favicon.jsx`。

### Sun-Panel

[S1]: https://github.com/hslr-s/sun-panel/blob/6119acf2258dd018dc18f68c1ce732b755b15e63/src/views/home/components/EditItem/index.vue
[S2]: https://github.com/hslr-s/sun-panel/blob/6119acf2258dd018dc18f68c1ce732b755b15e63/src/api/panel/itemIcon.ts
[S3]: https://github.com/hslr-s/sun-panel/blob/6119acf2258dd018dc18f68c1ce732b755b15e63/service/api/api_v1/panel/itemIcon.go
[S4]: https://github.com/hslr-s/sun-panel/blob/6119acf2258dd018dc18f68c1ce732b755b15e63/service/lib/siteFavicon/favico.go
[S5]: https://github.com/hslr-s/sun-panel/blob/6119acf2258dd018dc18f68c1ce732b755b15e63/service/router/A_ENTER.go
[S6]: https://github.com/hslr-s/sun-panel/blob/6119acf2258dd018dc18f68c1ce732b755b15e63/src/components/common/ItemIcon/index.vue

- [S1 编辑按钮与获取结果][S1]：`src/views/home/components/EditItem/index.vue` L114至135、L193、L201。
- [S2 前端 API][S2]：`src/api/panel/itemIcon.ts` L45至50。
- [S3 服务端下载落盘与返回][S3]：`service/api/api_v1/panel/itemIcon.go` L199至272。
- [S4 HTML 解析和下载][S4]：`service/lib/siteFavicon/favico.go` L29至46、L67至110、L132至176。
- [S5 API 前缀和静态文件服务][S5]：`service/router/A_ENTER.go`；登录拦截见同 commit 的 `service/router/panel/itemIcon.go`。
- [S6 首页图片展示分支][S6]：`src/components/common/ItemIcon/index.vue`。

### 浏览器官方材料

[W1]: https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Same-origin_policy
[W2]: https://developer.mozilla.org/en-US/docs/Web/HTML/How_to/CORS_enabled_image
[W3]: https://developer.mozilla.org/en-US/docs/Web/API/Response/blob
[W4]: https://developer.chrome.com/docs/extensions/how-to/ui/favicons
[W5]: https://developer.mozilla.org/en-US/docs/Web/API/Cache/put
[W6]: https://fetch.spec.whatwg.org/

- [W1 MDN 同源策略][W1]：Cross-origin network access。
- [W2 MDN 跨域图片和 canvas][W2]：Security and tainted canvases。
- [W3 MDN Response.blob][W3]：opaque 响应 Blob 限制。
- [W4 Chrome MV3 favicon][W4]：manifest 权限、URL 生成与 web accessible resources。
- [W5 MDN Cache.put][W5]：opaque 可存，区别于 add/addAll。
- [W6 WHATWG Fetch][W6]：opaque filtered response、CORS protocol、Cross-Origin-Resource-Policy header。
