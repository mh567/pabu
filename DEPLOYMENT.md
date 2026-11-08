# Pabu 部署

Pabu 通过仓库根目录的 `pabu.sh` 管理安装、启停、更新和卸载。脚本会下载最新 Release 的源码包、安装依赖并启动服务。

## 运行要求

- Node.js 22 或更新版本
- curl 或 wget，以及 tar
- Linux 或 macOS
- 公网部署时配置 HTTPS 反向代理

## 一键安装

```sh
curl -fsSL https://raw.githubusercontent.com/mh567/pabu/main/pabu.sh | bash
```

默认安装到 `~/pabu`，访问地址为 `http://127.0.0.1:4001`。

指定安装目录：

```sh
curl -fsSL https://raw.githubusercontent.com/mh567/pabu/main/pabu.sh | PABU_DIR=/opt/pabu bash
```

安装脚本会：

1. 校验 Node 版本，低于 22 直接中止
2. 下载最新 Release 对应的源码包
3. 执行 `npm ci --omit=dev`
4. 从 `.env.example` 生成 `.env`
5. 启动服务

非交互安装不会覆盖已有安装目录。已有部署请改用 `./pabu.sh update`。

## 日常管理

```sh
cd ~/pabu

./pabu.sh start      # 启动
./pabu.sh stop       # 停止
./pabu.sh restart    # 重启
./pabu.sh status     # 状态、健康检查和进程信息
./pabu.sh logs       # 实时日志
./pabu.sh update     # 更新到最新版本
./pabu.sh uninstall  # 卸载（删除配置、数据库和同步数据）
```

日志写入 `logs/server.log`，依赖安装日志写入 `logs/npm-install.log`。

## 配置

管理后台地址为 `http://127.0.0.1:4001/admin`，首页不提供管理入口。首次访问会要求输入管理密码。

复制配置模板后按需修改：

```sh
cp .env.example .env
```

`.env` 常用项：

```sh
SERVER_HOST=127.0.0.1
SERVER_PORT=4001
```

完整选项见 `.env.example` 与 `server-config.example.json`。首次启动会生成管理员初始密码文件 `.admin-password.json`，默认弱密码 `admin123` 首次登录后必须修改。`.env`、`.admin-password.json`、`config.json` 和 `pabu.db` 由服务或安装脚本限制为仅当前用户可读写。

修改配置后执行 `./pabu.sh restart`。

## 开机自启

Linux systemd 环境：

```sh
sudo ./pabu.sh enable    # 安装并启动 systemd 服务
sudo ./pabu.sh disable   # 移除 systemd 服务
```

启用后可以直接使用 `systemctl status pabu` 和 `systemctl restart pabu`。macOS 请按 `./pabu.sh enable` 输出的 launchd 提示配置。

## 更新

```sh
cd ~/pabu
./pabu.sh update
```

更新流程：

1. 校验 Node 版本，不满足时停服前中止
2. 下载最新 Release 源码
3. 备份用户数据到 `/tmp` 下的临时目录
4. 替换程序文件
5. 恢复用户数据并执行 `npm ci --omit=dev`
6. 重启服务

以下文件在更新时保留：`config.json`、`.env`、`server-config.json`、`.admin-password.json`、`pabu.db`、`pabu.db-wal`、`pabu.db-shm`。已登录的浏览器不会因更新掉线。

## 数据与备份

- `pabu.db`：管理员会话、导航版本、口令同步空间、邀请码及恢复回执
- `config.json`：服务发布的默认导航模板
- `.admin-password.json`：管理员口令哈希
- 浏览器 IndexedDB `pabu-personal`：访客本地导航

停机后备份：

```sh
cd ~/pabu
tar -czf pabu-backup-$(date +%Y%m%d).tar.gz \
  config.json .admin-password.json .env server-config.json pabu.db
```

恢复后执行 `./pabu.sh restart`。分享内容为临时数据，保存在运行进程内存中，服务重启后会清除。

## 反向代理与 HTTPS

Nginx 示例：

```nginx
server {
    listen 80;
    server_name nav.example.com;

    location / {
        proxy_pass http://127.0.0.1:4001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

登录 Cookie 的 `Secure` 标记由服务端根据 `X-Forwarded-Proto` 自动判断，经 HTTPS 到达时自动添加，纯 HTTP 部署自动省略。`COOKIE_SECURE` 仅用于覆盖自动判断，一般不需要修改。

## 健康检查

```sh
curl -s http://127.0.0.1:4001/api/health
# {"status":"ok","timestamp":"..."}
```

## 手动部署

不使用脚本时可以从 Release 页面下载对应 tag 的源码压缩包，解压后执行：

```sh
npm ci
./pabu.sh start
```

## 故障排除

```sh
./pabu.sh status        # 是否运行、健康检查、端口
./pabu.sh logs          # 启动失败原因
node --version          # 必须为 v22 或更高
lsof -i:4001            # 端口占用
```

启动失败时也可以直接在前台运行 `node server.js` 查看完整输出。
