# 当前工作

## 目标

完成 Pabu 与 Nav Sylph 的独立拆分，提供独立的产品标识、版本、存储命名和部署说明。

## 完成情况

- 保留导航管理、本地配置、管理员默认模板、口令同步、邀请码治理、同步空间治理和临时加密文本分享。
- 移除服务器监控与 Go agent、私人收藏库、备忘与待办、时间线、微博热搜和 WebDAV。服务器端对应接口返回 404。
- 邀请码采用管理员签发的一次性策略，有效期 48 小时，不开放注册。
- Pabu 默认端口为 4001，管理会话 Cookie 为 `pabu_session`，SQLite 库为 `pabu.db`，访客 IndexedDB 为 `pabu-personal`，Service Worker 缓存使用 Pabu 标识。
- 版本从 `0.1.0` 开始。初始提交 `4de2dd8` 已推送到 `https://github.com/mh567/pabu` 的 `main`，并发布 v0.1.0；Release 不附带二进制包，部署通过仓库源码执行 `npm ci`。
- 新增根目录管理脚本 `pabu.sh`，提供一键安装、更新、启停、状态、日志、systemd 自启和卸载。安装与更新直接下载对应 Release tag 的源码包，不依赖 Release 附件；更新前备份并恢复 `.env`、`config.json`、`server-config.json`、`.admin-password.json` 和 `pabu.db*`。
- `README.md` 与 `DEPLOYMENT.md` 的部署章节改为脚本化流程。
- 修复 `pabu.sh` 在 systemd 单元已存在但未运行时无法停止手动进程的问题。启用和启动前会先清理手动进程，systemd 启动失败时输出 `systemctl status` 与最近 30 行 journal。

## 验证

- `node --test tests/*.test.js`：339 项通过，0 项失败，0 项跳过。日志：`/tmp/pabu-independent-final-tests.log`；本地同次结果：`/tmp/pabu-tests-final.tap`。
- 核心 HTTP 测试验证管理员强密码与会话、导航默认模板读写、同步空间与邀请码治理、临时分享读后删除，以及私人 API 路由不存在。
- 新建内存 SQLite 库实际只含会话、导航、同步空间和治理所需的 8 张表，不含监控、收藏、备忘、待办、时间线和恢复表。
- 主代理完成真实浏览器闭环：管理员登录、生成邀请码、访客建空间、同步导航主题、第二个 HTTP 设备连接并读取数据、刷新恢复连接、加密分享取回及阅后删除。
- JavaScript 语法检查和空白差异检查通过。干净环境执行 `npm ci` 已在临时目录的管理脚本测试中验证。
- 交接前复核：73 个源码与配置文件语法及空白检查通过；版本在 `package.json`、`version.json`、`CHANGELOG.json`、`package-lock.json` 四处一致为 `0.1.0`，依赖声明与锁文件一致。
- 本轮管理脚本验证：`bash -n pabu.sh` 通过；在临时目录模拟远程安装、强制更新、停止、启动和重启均成功，健康检查返回 200，更新后 `.env` 标记和 `config.json` 保留，安装目录内的 `pabu.sh` 与仓库版本校验一致。本轮未改动应用代码，未重跑 339 项测试。
- Pabu 项目目录内没有安装依赖；管理脚本验证在临时目录执行了 `npm ci`，测试目录已清理。Pabu 首次运行前需执行 `npm ci` 或使用 `pabu.sh install`。

## 边界

导航同步内容由服务端保存并可读取，不提供端到端加密；临时文本分享使用浏览器加密。少量未引用的旧功能 CSS 规则仍保留，暂未影响界面与接口。
