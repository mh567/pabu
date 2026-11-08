# Pabu导航

Pabu导航 是可自行部署的导航首页，核心功能是导航编辑、多端同步与文本分享。

## 核心功能

- **导航编辑**：增删分类和链接，管理搜索引擎、图标与视觉主题。访客配置保存在浏览器 IndexedDB；管理员在 `/admin` 的一比一画布中直接编辑站点默认导航，保存后对未自定义的访客生效。
- **多端同步**：通过口令创建或连接同步空间，导航修改自动同步。支持设备授权、管理员邀请码和空间治理。
- **文本分享**：使用浏览器加密的临时文本，可设 PIN 和有效期，通过链接或取件码分享。

## 管理

- 首页始终显示当前用户自己的本地导航，管理员登录只获得管理权限，不切换首页
- 管理后台位于 `/admin`，站点默认导航在一比一画布中直接编辑和发布
- 管理员可编辑同步空间备注、停用、删除和重置设备，不读取空间正文或设备凭据

同步邀请码由管理员在「管理」面板生成。邀请码一次性使用，有效期 48 小时，不提供开放注册。知晓同步口令的人可以读写对应空间，请妥善保管。导航同步数据由服务端保存并可读取，不提供端到端加密。临时文本分享单独使用浏览器加密，服务端只暂存密文。

## 部署

需要 Node.js 22 或更新版本。建议使用管理脚本安装：

```sh
curl -fsSL https://raw.githubusercontent.com/mh567/pabu/main/pabu.sh | bash
```

默认安装到 `~/pabu` 并监听 `127.0.0.1:4001`。指定目录：

```sh
curl -fsSL https://raw.githubusercontent.com/mh567/pabu/main/pabu.sh | PABU_DIR=/opt/pabu bash
```

```sh
cd ~/pabu
./pabu.sh start      # 启动
./pabu.sh status     # 状态与健康检查
./pabu.sh update     # 更新，保留配置和数据库
sudo ./pabu.sh enable  # 开机自启（systemd）
```

默认弱密码 `admin123` 首次登录后会要求设置强密码。公网部署应使用 HTTPS 反向代理，并将 `COOKIE_SECURE=true` 保持开启。

可复制 `.env.example` 为 `.env` 设置监听地址、端口、HTTPS 和日志路径。完整选项见 `server-config.example.json`。服务将配置和会话保存在 `config.json` 与 `pabu.db`，数据库和凭据文件由服务限制为仅当前用户可读写。完整说明见 `DEPLOYMENT.md`。

## 本地开发

```sh
npm start
node --test tests/*.test.js
```

Pabu 从 Habu 拆分为独立项目，版本从 `0.1.0` 开始。邀请码策略沿用一次性邀请码，由管理员治理同步空间。
