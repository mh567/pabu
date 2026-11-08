#!/bin/bash
#
# Pabu 统一管理脚本
#
# 远程安装: curl -fsSL https://raw.githubusercontent.com/mh567/pabu/main/pabu.sh | bash
# 本地使用: ./pabu.sh [command]
#

set -e

SCRIPT_SELF=""
if [ -f "$0" ]; then
    case "$0" in
        /*) SCRIPT_SELF="$0" ;;
        *) SCRIPT_SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")" ;;
    esac
fi

APP_NAME="pabu"
REPO_OWNER="mh567"
REPO_NAME="pabu"
GITHUB_API="https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}"
RAW_URL="https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/main"

# 下载失败时依次尝试的 GitHub 加速前缀。
GITHUB_MIRRORS=(
    ""
    "https://ghproxy.cn"
    "https://ghfast.top"
)

if [ -f "$(dirname "$0")/server.js" ] 2>/dev/null; then
    APP_DIR="$(cd "$(dirname "$0")" && pwd)"
    MODE="local"
else
    APP_DIR="${PABU_DIR:-$HOME/pabu}"
    MODE="remote"
fi

PID_FILE="${APP_DIR}/.pabu.pid"
LOG_DIR="${APP_DIR}/logs"
LOG_FILE="${LOG_DIR}/server.log"
NODE_BIN="${NODE_BIN:-node}"
SYSTEMD_DIR="/etc/systemd/system"

REQUIRED_NODE_MAJOR=22

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

log_info()  { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }
log_step()  { echo -e "${BLUE}[STEP]${NC} $1"; }

check_command() {
    command -v "$1" > /dev/null 2>&1
}

detect_os() {
    case "$(uname -s)" in
        Linux*)
            if grep -q Microsoft /proc/version 2>/dev/null; then
                echo "wsl"
            else
                echo "linux"
            fi
            ;;
        Darwin*) echo "macos";;
        CYGWIN*|MINGW*|MSYS*) echo "windows";;
        *) echo "unknown";;
    esac
}

OS=$(detect_os)

has_systemd() {
    [ "$OS" = "linux" ] && check_command systemctl && systemctl --version > /dev/null 2>&1
}

has_app_systemd_service() {
    has_systemd || return 1
    local unit="${APP_NAME}.service"
    local load_state
    load_state=$(systemctl show --property=LoadState --value "$unit" 2>/dev/null) || return 1
    [ "$load_state" = "loaded" ] || return 1
    local work_dir
    work_dir=$(systemctl show --property=WorkingDirectory --value "$unit" 2>/dev/null) || return 1
    [ "${work_dir%/}" = "${APP_DIR%/}" ]
}

control_systemd_service() {
    if [ "$(id -u)" = "0" ]; then
        systemctl "$1" "${APP_NAME}.service"
    elif check_command sudo; then
        sudo systemctl "$1" "${APP_NAME}.service"
    else
        log_error "管理 systemd 服务需要 sudo 权限"
        return 1
    fi
}

check_root() {
    if [ "$(id -u)" != "0" ]; then
        log_error "此命令需要 root 权限，请使用: sudo $0 $1"
        exit 1
    fi
}

print_banner() {
    echo -e "${CYAN}"
    echo "╔════════════════════════════════════════╗"
    echo "║             Pabu 管理脚本              ║"
    echo "╚════════════════════════════════════════╝"
    echo -e "${NC}"
}

check_dependencies() {
    local missing=()

    if ! check_command curl && ! check_command wget; then
        missing+=("curl 或 wget")
    fi
    if ! check_command tar; then
        missing+=("tar")
    fi
    if ! check_command node; then
        missing+=("node")
    fi
    if ! check_command npm; then
        missing+=("npm")
    fi

    if [ ${#missing[@]} -gt 0 ]; then
        log_error "缺少依赖: ${missing[*]}"
        echo ""
        echo "请先安装:"
        case "$OS" in
            linux|wsl)
                echo "  Ubuntu/Debian: sudo apt update && sudo apt install -y curl tar nodejs npm"
                echo "  CentOS/RHEL:   sudo yum install -y curl tar nodejs npm"
                echo "  Arch:          sudo pacman -S curl tar nodejs npm"
                ;;
            macos)
                echo "  Homebrew: brew install node"
                ;;
            windows)
                echo "  下载 Node.js: https://nodejs.org/"
                ;;
        esac
        exit 1
    fi
}

node_major_version() {
    local raw
    raw="$("$NODE_BIN" -v 2>/dev/null)" || return 1
    raw="${raw#v}"
    raw="${raw%%.*}"
    case "$raw" in ''|*[!0-9]*) return 1 ;; esac
    echo "$raw"
}

check_node_version() {
    local major
    if ! major="$(node_major_version)"; then
        log_error "无法确定 Node 版本（NODE_BIN=${NODE_BIN}），请确认 node 可用"
        return 1
    fi
    if [ "$major" -lt "$REQUIRED_NODE_MAJOR" ]; then
        log_error "当前 Node 主版本为 ${major}，Pabu 要求 Node ${REQUIRED_NODE_MAJOR} 及以上"
        echo ""
        echo "  better-sqlite3 在 Node 20 及以下启动时会段错误退出。"
        echo "  升级 Node 后重新执行本命令："
        echo "    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -"
        echo "    sudo apt-get install -y nodejs"
        echo ""
        return 1
    fi
    return 0
}

load_env() {
    if [ -f "${APP_DIR}/.env" ]; then
        set -a
        # shellcheck disable=SC1091
        . "${APP_DIR}/.env"
        set +a
    fi
}

get_config() {
    load_env
    PORT="${SERVER_PORT:-4001}"
    HOST="${SERVER_HOST:-127.0.0.1}"
}

fetch_text() {
    local url="$1"
    local mirror try_url
    for mirror in "${GITHUB_MIRRORS[@]}"; do
        try_url="$url"
        if [ -n "$mirror" ]; then
            case "$url" in
                https://github.com/*|https://api.github.com/*|https://raw.githubusercontent.com/*)
                    try_url="${mirror}/${url}"
                    ;;
                *)
                    continue
                    ;;
            esac
        fi
        if check_command curl; then
            curl -fsSL --connect-timeout 10 --max-time 180 "$try_url" 2>/dev/null && return 0
        elif check_command wget; then
            wget -qO- --connect-timeout=10 --timeout=180 "$try_url" 2>/dev/null && return 0
        fi
    done
    return 1
}

fetch_file() {
    local url="$1"
    local dest="$2"
    local mirror try_url
    for mirror in "${GITHUB_MIRRORS[@]}"; do
        try_url="$url"
        if [ -n "$mirror" ]; then
            case "$url" in
                https://github.com/*|https://api.github.com/*|https://raw.githubusercontent.com/*)
                    try_url="${mirror}/${url}"
                    ;;
                *)
                    continue
                    ;;
            esac
            log_info "尝试镜像: ${mirror}"
        fi
        if check_command curl; then
            curl -fsSL --connect-timeout 10 --max-time 180 -o "$dest" "$try_url" 2>/dev/null && return 0
        elif check_command wget; then
            wget -q --connect-timeout=10 --timeout=180 -O "$dest" "$try_url" 2>/dev/null && return 0
        fi
    done
    return 1
}

get_latest_source() {
    local response=""
    response="$(fetch_text "${GITHUB_API}/releases/latest" || true)"

    LATEST_TAG=""
    if [ -n "$response" ]; then
        LATEST_TAG=$(printf '%s' "$response" | grep -o '"tag_name"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | cut -d'"' -f4)
    fi

    if [ -n "$LATEST_TAG" ]; then
        LATEST_VERSION="${LATEST_TAG#v}"
        SOURCE_URL="https://github.com/${REPO_OWNER}/${REPO_NAME}/archive/refs/tags/${LATEST_TAG}.tar.gz"
        return 0
    fi

    log_warn "未获取到 Release 信息，改用 main 分支源码"
    LATEST_TAG="main"
    SOURCE_URL="https://github.com/${REPO_OWNER}/${REPO_NAME}/archive/refs/heads/main.tar.gz"
    response="$(fetch_text "${RAW_URL}/version.json" || true)"
    LATEST_VERSION=$(printf '%s' "$response" | grep -o '"version"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | cut -d'"' -f4)
    [ -n "$LATEST_VERSION" ] || LATEST_VERSION="main"
}

extract_source() {
    local url="$1"
    local dest="$2"
    local tmp_tar="/tmp/pabu-src-$$.tar.gz"
    local tmp_dir="/tmp/pabu-extract-$$"

    rm -rf "$tmp_dir" "$tmp_tar"
    mkdir -p "$tmp_dir"

    log_step "下载源码..."
    if ! fetch_file "$url" "$tmp_tar"; then
        log_error "源码下载失败"
        rm -rf "$tmp_dir" "$tmp_tar"
        return 1
    fi

    log_step "解压源码..."
    if ! tar -xzf "$tmp_tar" -C "$tmp_dir"; then
        log_error "源码解压失败"
        rm -rf "$tmp_dir" "$tmp_tar"
        return 1
    fi

    local extracted
    extracted=$(find "$tmp_dir" -mindepth 1 -maxdepth 1 -type d | head -1)
    if [ -z "$extracted" ]; then
        log_error "解压后未找到源码目录"
        rm -rf "$tmp_dir" "$tmp_tar"
        return 1
    fi

    mkdir -p "$dest"
    cp -a "$extracted"/. "$dest"/

    rm -rf "$tmp_dir" "$tmp_tar"
    return 0
}

install_dependencies() {
    mkdir -p "${LOG_DIR}"
    local npm_log="${LOG_DIR}/npm-install.log"
    local npm_cmd=(npm install --omit=dev)

    if [ -f package-lock.json ]; then
        npm_cmd=(npm ci --omit=dev)
    fi

    : > "$npm_log"

    log_info "安装依赖（日志: ${npm_log}）..."
    {
        echo "===== npm: default registry ====="
        "${npm_cmd[@]}"
    } >> "$npm_log" 2>&1 && {
        tail -20 "$npm_log"
        log_info "依赖安装完成"
        return 0
    }

    if grep -Eq 'EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN' "$npm_log"; then
        log_warn "当前 npm 源连接失败，尝试 IPv4 优先..."
        {
            echo ""
            echo "===== npm: ipv4 first ====="
            NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--dns-result-order=ipv4first" "${npm_cmd[@]}"
        } >> "$npm_log" 2>&1 && {
            tail -20 "$npm_log"
            log_info "依赖安装完成"
            return 0
        }

        log_warn "IPv4 优先仍未成功，尝试 npm 镜像..."
        {
            echo ""
            echo "===== npm: npmmirror registry, ipv4 first ====="
            NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--dns-result-order=ipv4first" \
                "${npm_cmd[@]}" \
                --registry=https://registry.npmmirror.com \
                --replace-registry-host=always
        } >> "$npm_log" 2>&1 && {
            tail -20 "$npm_log"
            log_info "依赖安装完成"
            return 0
        }
    fi

    log_error "依赖安装失败，日志: ${npm_log}"
    tail -50 "$npm_log" || true
    return 1
}

ensure_manager_script() {
    local target="${APP_DIR}/${APP_NAME}.sh"
    if [ -f "$target" ]; then
        chmod +x "$target"
        return 0
    fi

    if [ -n "$SCRIPT_SELF" ] && [ -f "$SCRIPT_SELF" ] && [ "$(basename "$SCRIPT_SELF")" = "${APP_NAME}.sh" ]; then
        cp "$SCRIPT_SELF" "$target"
        chmod +x "$target"
        return 0
    fi

    local tmp="${target}.tmp.$$"
    rm -f "$tmp"
    if fetch_file "${RAW_URL}/${APP_NAME}.sh" "$tmp" \
        && head -1 "$tmp" | grep -q '^#!.*bash' \
        && grep -q "APP_NAME=\"${APP_NAME}\"" "$tmp"; then
        mv "$tmp" "$target"
        chmod +x "$target"
        return 0
    fi

    rm -f "$tmp"
    log_warn "未能获取管理脚本，可手动下载: ${RAW_URL}/${APP_NAME}.sh"
    return 1
}

is_running() {
    if [ -f "${PID_FILE}" ]; then
        local pid
        pid=$(cat "${PID_FILE}")
        if ps -p ${pid} > /dev/null 2>&1; then
            return 0
        fi
    fi
    return 1
}

check_port() {
    local port=$1
    if check_command lsof; then
        lsof -i:${port} > /dev/null 2>&1
        return $?
    elif check_command ss; then
        ss -tuln | grep -q ":${port} "
        return $?
    elif check_command netstat; then
        netstat -tuln 2>/dev/null | grep -q ":${port} "
        return $?
    fi
    return 1
}

ensure_local_install() {
    if [ ! -f "${APP_DIR}/server.js" ]; then
        log_error "未找到安装目录: ${APP_DIR}"
        log_info "请先运行: ./${APP_NAME}.sh install"
        exit 1
    fi
}

do_install() {
    print_banner
    log_info "操作系统: $OS"
    echo ""

    check_dependencies
    check_node_version || exit 1
    log_info "Node.js: $(node --version)"
    echo ""

    log_step "获取最新版本..."
    get_latest_source
    log_info "最新版本: ${LATEST_VERSION}"

    if [ "$MODE" = "remote" ]; then
        if [ -f "${APP_DIR}/server.js" ]; then
            log_warn "安装目录已存在: ${APP_DIR}"
            if [ ! -t 0 ]; then
                log_error "为避免覆盖现有数据，非交互安装不会删除已有目录"
                log_info "更新现有安装请运行: ${APP_DIR}/${APP_NAME}.sh update"
                exit 1
            fi
            log_warn "重新安装会删除该目录内的配置、数据库和同步数据"
            read -p "确定删除并重新安装? [y/N] " -n 1 -r
            echo ""
            if [[ ! $REPLY =~ ^[Yy]$ ]]; then
                log_info "取消安装"
                exit 0
            fi
            if [ -f "${APP_DIR}/${APP_NAME}.sh" ]; then
                (cd "${APP_DIR}" && ./"${APP_NAME}".sh stop) 2>/dev/null || true
            fi
            rm -rf "$APP_DIR"
        fi

        if ! extract_source "$SOURCE_URL" "$APP_DIR"; then
            exit 1
        fi
        log_info "已安装到: ${APP_DIR}"
    fi

    cd "$APP_DIR"
    mkdir -p "${LOG_DIR}"
    ensure_manager_script || true

    if ! install_dependencies; then
        log_error "安装未完成"
        exit 1
    fi

    if [ ! -f "${APP_DIR}/.env" ] && [ -f "${APP_DIR}/.env.example" ]; then
        log_step "创建配置文件..."
        cp "${APP_DIR}/.env.example" "${APP_DIR}/.env"
        log_info "已创建 .env（可按需编辑）"
    fi

    chmod +x "${APP_DIR}/${APP_NAME}.sh" 2>/dev/null || true
    [ -f "${APP_DIR}/.env" ] && chmod 600 "${APP_DIR}/.env"
    [ -f "${APP_DIR}/.admin-password.json" ] && chmod 600 "${APP_DIR}/.admin-password.json"

    local service_started=false
    if [ -t 0 ]; then
        read -p "是否立即启动服务? [Y/n] " -n 1 -r
        echo ""
        if [[ ! $REPLY =~ ^[Nn]$ ]]; then
            do_start
            service_started=true
        fi
    else
        do_start
        service_started=true
    fi

    get_config
    echo ""
    echo -e "${GREEN}╔════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${GREEN}║                    安装完成                                ║${NC}"
    echo -e "${GREEN}╚════════════════════════════════════════════════════════════╝${NC}"
    echo ""
    echo -e "${CYAN}── 安装信息 ──${NC}"
    echo "  安装目录:     ${APP_DIR}"
    echo "  安装版本:     v${LATEST_VERSION}"
    echo ""
    echo -e "${CYAN}── 服务状态 ──${NC}"
    if [ "$service_started" = true ] && is_running; then
        echo -e "  运行状态:     ${GREEN}运行中${NC} (PID: $(cat "${PID_FILE}"))"
    elif has_systemd && systemctl is-active --quiet "${APP_NAME}" 2>/dev/null; then
        echo -e "  运行状态:     ${GREEN}运行中${NC} (systemd)"
    else
        echo -e "  运行状态:     ${YELLOW}未启动${NC}"
    fi
    if has_systemd; then
        echo -e "  开机自启:     ${YELLOW}未启用${NC} (可用 sudo ./${APP_NAME}.sh enable 启用)"
    else
        echo -e "  开机自启:     不适用 (当前系统: ${OS})"
    fi
    echo ""
    echo -e "${CYAN}── 访问信息 ──${NC}"
    echo "  访问地址:     http://${HOST}:${PORT}"
    echo -e "  管理密码:     ${YELLOW}admin123${NC} (首次登录后必须修改)"
    echo ""
    echo -e "${CYAN}── 管理命令 ──${NC}"
    echo "  cd ${APP_DIR}"
    echo "  ./${APP_NAME}.sh start       # 启动服务"
    echo "  ./${APP_NAME}.sh stop        # 停止服务"
    echo "  ./${APP_NAME}.sh restart     # 重启服务"
    echo "  ./${APP_NAME}.sh status      # 查看状态"
    echo "  ./${APP_NAME}.sh logs        # 查看日志"
    echo "  ./${APP_NAME}.sh update      # 更新版本"
    echo "  ./${APP_NAME}.sh uninstall   # 卸载"
    if has_systemd; then
        echo "  sudo ./${APP_NAME}.sh enable   # 开机自启"
        echo "  sudo ./${APP_NAME}.sh disable  # 禁用自启"
    fi
    echo ""
    echo -e "${CYAN}── 配置说明 ──${NC}"
    echo "  服务器配置:   编辑 .env 文件（端口、HTTPS 等）"
    echo "  修改密码:     登录后在管理面板修改"
    echo ""
}

show_service_logs() {
    systemctl status "${APP_NAME}" --no-pager 2>/dev/null || true
    if check_command journalctl; then
        echo ""
        journalctl -u "${APP_NAME}" -n 30 --no-pager 2>/dev/null || true
    fi
}

stop_manual_process() {
    if ! is_running; then
        log_warn "服务未运行"
        [ -f "${PID_FILE}" ] && rm -f "${PID_FILE}"
        return 0
    fi

    local pid
    pid=$(cat "${PID_FILE}")
    log_step "停止服务 (PID: ${pid})..."

    kill -TERM ${pid} 2>/dev/null || true

    local count=0
    while is_running && [ ${count} -lt 10 ]; do
        sleep 1
        count=$((count + 1))
        echo -n "."
    done
    echo ""

    if is_running; then
        log_warn "强制终止..."
        kill -KILL ${pid} 2>/dev/null || true
        sleep 1
    fi

    rm -f "${PID_FILE}"
    log_info "服务已停止"
}

do_start() {
    get_config

    if has_app_systemd_service; then
        if systemctl is-active --quiet "${APP_NAME}.service"; then
            log_warn "systemd 服务已在运行"
            return 0
        fi
        if is_running; then
            log_warn "检测到手动启动的进程，先停止以避免端口冲突"
            stop_manual_process
        fi
        log_step "启动 systemd 服务..."
        if ! control_systemd_service start; then
            log_error "systemd 服务启动失败"
            show_service_logs
            return 1
        fi
        if ! systemctl is-active --quiet "${APP_NAME}.service"; then
            log_error "systemd 服务启动后未进入运行状态"
            show_service_logs
            return 1
        fi
        log_info "systemd 服务启动成功"
        return 0
    fi

    if is_running; then
        log_warn "服务已在运行 (PID: $(cat "${PID_FILE}"))"
        return 0
    fi

    if check_port "$PORT"; then
        log_error "端口 ${PORT} 已被占用"
        if check_command lsof; then
            lsof -i:${PORT} | head -3
        fi
        exit 1
    fi

    mkdir -p "${LOG_DIR}"

    log_step "启动服务..."
    cd "${APP_DIR}"
    nohup ${NODE_BIN} server.js >> "${LOG_FILE}" 2>&1 &
    echo $! > "${PID_FILE}"

    sleep 2

    if is_running; then
        log_info "服务启动成功 (PID: $(cat "${PID_FILE}"))"
        return 0
    else
        log_error "启动失败，请查看日志: tail -50 ${LOG_FILE}"
        exit 1
    fi
}

do_stop() {
    if has_app_systemd_service; then
        if systemctl is-active --quiet "${APP_NAME}.service"; then
            log_step "停止 systemd 服务..."
            if ! control_systemd_service stop; then
                log_error "systemd 服务停止失败"
                return 1
            fi
            if systemctl is-active --quiet "${APP_NAME}.service"; then
                log_error "systemd 服务仍在运行"
                return 1
            fi
            log_info "systemd 服务已停止"
            return 0
        fi

        log_warn "systemd 服务未运行"
        if ! is_running; then
            [ -f "${PID_FILE}" ] && rm -f "${PID_FILE}"
            return 0
        fi
        log_warn "检测到手动启动的进程，继续停止"
    fi

    stop_manual_process
}

do_restart() {
    do_stop
    sleep 1
    do_start
}

do_status() {
    get_config

    echo ""
    echo -e "${BLUE}════════════════════════════════════════${NC}"
    echo -e "${BLUE}            Pabu 服务状态               ${NC}"
    echo -e "${BLUE}════════════════════════════════════════${NC}"
    echo ""

    if has_systemd && systemctl is-active --quiet "${APP_NAME}" 2>/dev/null; then
        echo -e "  运行模式: ${GREEN}systemd${NC}"
        echo -e "  状态:     ${GREEN}运行中${NC}"
        echo ""
        systemctl status "${APP_NAME}" --no-pager -l 2>/dev/null | head -10
    elif is_running; then
        local pid
        pid=$(cat "${PID_FILE}")
        echo -e "  运行模式: 手动"
        echo -e "  状态:     ${GREEN}运行中${NC}"
        echo "  PID:      ${pid}"
        echo "  地址:     http://${HOST}:${PORT}"
        echo ""

        if check_command curl; then
            local http_code
            http_code=$(curl -s -o /dev/null -w "%{http_code}" "http://${HOST}:${PORT}/api/health" 2>/dev/null || echo "000")
            if [ "${http_code}" = "200" ]; then
                echo -e "  健康检查: ${GREEN}正常${NC}"
            else
                echo -e "  健康检查: ${YELLOW}异常${NC} (HTTP ${http_code})"
            fi
        fi
        echo ""

        echo "  进程信息:"
        ps -p ${pid} -o pid,ppid,%cpu,%mem,etime 2>/dev/null | head -2
    else
        echo -e "  状态: ${RED}未运行${NC}"
        if [ -f "${PID_FILE}" ]; then
            echo -e "  ${YELLOW}警告: 存在残留 PID 文件${NC}"
        fi
    fi
    echo ""
}

do_logs() {
    if [ ! -f "${LOG_FILE}" ]; then
        log_error "日志文件不存在: ${LOG_FILE}"
        exit 1
    fi

    echo "显示日志 (Ctrl+C 退出)..."
    echo ""
    tail -f "${LOG_FILE}"
}

do_update() {
    ensure_local_install
    print_banner
    cd "$APP_DIR"

    check_node_version || exit 1

    local old_version=""
    if [ -f "version.json" ]; then
        old_version=$(grep -o '"version"[[:space:]]*:[[:space:]]*"[^"]*"' version.json | cut -d'"' -f4)
    fi
    log_info "当前版本: ${old_version:-未知}"

    log_step "检查最新版本..."
    get_latest_source
    log_info "最新版本: ${LATEST_VERSION}"

    if [ "$old_version" = "$LATEST_VERSION" ]; then
        log_info "已是最新版本，无需更新"
        exit 0
    fi

    log_step "停止服务..."
    if ! do_stop; then
        log_error "服务未能停止，更新已取消"
        return 1
    fi

    log_step "备份用户数据..."
    local backup_dir="/tmp/pabu-backup-$(date +%s)"
    mkdir -p "$backup_dir"
    local user_files=(config.json .admin-password.json .env server-config.json pabu.db pabu.db-wal pabu.db-shm)
    local file
    for file in "${user_files[@]}"; do
        [ -f "$file" ] && cp "$file" "$backup_dir/"
    done

    log_step "下载新版本..."
    local update_dir="/tmp/pabu-update-$$"
    rm -rf "$update_dir"
    if ! extract_source "$SOURCE_URL" "$update_dir"; then
        log_error "下载失败，恢复运行..."
        rm -rf "$update_dir" "$backup_dir"
        do_start || true
        exit 1
    fi

    log_step "更新程序文件..."
    if [ ! -f "$update_dir/${APP_NAME}.sh" ] && [ -f "${APP_DIR}/${APP_NAME}.sh" ]; then
        cp "${APP_DIR}/${APP_NAME}.sh" "$update_dir/${APP_NAME}.sh"
    fi

    rm -rf public lib server-config scripts docs tests
    rm -f server.js package.json package-lock.json "${APP_NAME}.sh" version.json CHANGELOG.json
    rm -f .env.example server-config.example.json README.md DEPLOYMENT.md PRODUCT.md DESIGN.md AGENTS.md .gitignore

    cp -a "$update_dir"/. "$APP_DIR"/
    rm -rf "$update_dir"

    ensure_manager_script || true

    log_step "恢复用户数据..."
    for file in "${user_files[@]}"; do
        [ -f "$backup_dir/$file" ] && cp "$backup_dir/$file" .
    done
    rm -rf "$backup_dir"

    log_step "更新依赖..."
    install_dependencies

    chmod +x "${APP_NAME}.sh"

    log_step "启动服务..."
    do_start

    echo ""
    log_info "更新完成!"
    echo ""
    echo -e "${CYAN}版本更新: ${old_version:-未知} → ${LATEST_VERSION}${NC}"

    if [ -f "CHANGELOG.json" ]; then
        echo ""
        echo -e "${CYAN}── 更新亮点 ──${NC}"
        grep -o '"highlights"[[:space:]]*:[[:space:]]*\[[^]]*\]' CHANGELOG.json | head -1 | \
            sed 's/"highlights"[[:space:]]*:[[:space:]]*\[//; s/\]//; s/"//g; s/,/\n/g' | \
            while read -r line; do
                line=$(echo "$line" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
                [ -n "$line" ] && echo "  • $line"
            done
    fi
    echo ""
}

do_uninstall() {
    print_banner

    if [ ! -d "$APP_DIR" ]; then
        log_error "未找到安装目录: $APP_DIR"
        exit 1
    fi

    cd "$APP_DIR"

    echo -e "${YELLOW}警告: 这将删除 Pabu 及所有配置、数据库和同步数据!${NC}"
    echo ""
    echo "  安装目录: $APP_DIR"
    echo ""

    if [ ! -t 0 ]; then
        log_error "卸载操作需要交互式终端确认，请直接运行: ./${APP_NAME}.sh uninstall"
        exit 1
    fi

    read -p "确定要卸载吗? [y/N] " -n 1 -r
    echo ""

    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        log_info "取消卸载"
        exit 0
    fi

    if has_systemd; then
        if systemctl is-active --quiet "${APP_NAME}" 2>/dev/null; then
            log_step "停止 systemd 服务..."
            sudo systemctl stop "${APP_NAME}"
        fi
        if systemctl is-enabled --quiet "${APP_NAME}" 2>/dev/null; then
            log_step "禁用开机自启..."
            sudo systemctl disable "${APP_NAME}"
        fi
        if [ -f "${SYSTEMD_DIR}/${APP_NAME}.service" ]; then
            log_step "移除 systemd 服务文件..."
            sudo rm -f "${SYSTEMD_DIR}/${APP_NAME}.service"
            sudo systemctl daemon-reload
        fi
    fi

    if is_running; then
        log_step "停止服务进程..."
        do_stop
    elif [ -f "${PID_FILE}" ]; then
        rm -f "${PID_FILE}"
    fi

    log_step "删除文件..."
    cd ~
    rm -rf "$APP_DIR"

    echo ""
    log_info "卸载完成!"
    echo ""
}

do_enable() {
    if ! has_systemd; then
        log_error "当前系统不支持 systemd"
        echo ""
        case "$OS" in
            macos)
                echo "macOS 请使用 launchd 实现开机自启:"
                echo "  1. 创建 plist: ~/Library/LaunchAgents/com.pabu.plist"
                echo "  2. 加载: launchctl load ~/Library/LaunchAgents/com.pabu.plist"
                ;;
            windows|wsl)
                echo "Windows 请使用任务计划程序，启动 ${APP_DIR}/server.js。"
                ;;
        esac
        echo ""
        exit 1
    fi

    check_root "enable"
    log_step "安装 systemd 服务..."

    local run_user="${SUDO_USER:-root}"
    local node_path
    node_path=$(which node)

    cat > "${SYSTEMD_DIR}/${APP_NAME}.service" << EOF
[Unit]
Description=Pabu - Personal Navigation Page
After=network.target

[Service]
Type=simple
User=${run_user}
Group=${run_user}
WorkingDirectory=${APP_DIR}

ExecStart=${node_path} server.js
ExecReload=/bin/kill -HUP \$MAINPID

Restart=on-failure
RestartSec=5
StartLimitInterval=60
StartLimitBurst=3

Environment=NODE_ENV=production
EnvironmentFile=-${APP_DIR}/.env

StandardOutput=append:${LOG_DIR}/server.log
StandardError=append:${LOG_DIR}/server.log

[Install]
WantedBy=multi-user.target
EOF

    if is_running; then
        log_step "停止手动运行的服务..."
        do_stop
    fi

    log_step "启用并启动服务..."
    systemctl daemon-reload
    systemctl enable "${APP_NAME}"
    systemctl start "${APP_NAME}"

    sleep 2

    if systemctl is-active --quiet "${APP_NAME}"; then
        get_config
        echo ""
        log_info "systemd 服务安装成功!"
        echo ""
        echo "  服务名称: ${APP_NAME}"
        echo "  状态:     运行中"
        echo "  开机自启: 已启用"
        echo "  访问地址: http://${HOST}:${PORT}"
        echo ""
        echo "  管理命令:"
        echo "    sudo systemctl status ${APP_NAME}"
        echo "    sudo systemctl restart ${APP_NAME}"
        echo "    sudo ./${APP_NAME}.sh disable  # 移除服务"
        echo ""
    else
        log_error "服务启动失败"
        show_service_logs
        exit 1
    fi
}

do_disable() {
    if ! has_systemd; then
        log_error "当前系统不支持 systemd"
        exit 1
    fi

    check_root "disable"
    log_step "移除 systemd 服务..."

    systemctl stop "${APP_NAME}" 2>/dev/null || true
    systemctl disable "${APP_NAME}" 2>/dev/null || true

    if [ -f "${SYSTEMD_DIR}/${APP_NAME}.service" ]; then
        rm -f "${SYSTEMD_DIR}/${APP_NAME}.service"
        systemctl daemon-reload
    fi

    log_info "systemd 服务已移除"
    echo ""
    echo "可以继续使用手动模式:"
    echo "  ./${APP_NAME}.sh start"
    echo ""
}

show_help() {
    print_banner
    echo "用法: $0 <命令>"
    echo ""
    echo "安装与部署:"
    echo "  install     安装 Pabu（下载最新 Release 源码）"
    echo "  update      更新到最新版本（保留配置与数据）"
    echo "  uninstall   完全卸载"
    echo ""
    echo "服务管理:"
    echo "  start       启动服务"
    echo "  stop        停止服务"
    echo "  restart     重启服务"
    echo "  status      查看运行状态"
    echo "  logs        查看实时日志"
    echo ""
    if has_systemd; then
        echo "开机自启 (需要 sudo):"
        echo "  enable      安装为 systemd 服务"
        echo "  disable     移除 systemd 服务"
        echo ""
    fi
    echo "环境变量:"
    echo "  PABU_DIR     安装目录 (默认: ~/pabu)"
    echo ""
    echo "示例:"
    echo "  # 一键安装"
    echo "  curl -fsSL ${RAW_URL}/${APP_NAME}.sh | bash"
    echo ""
    echo "  # 指定目录安装"
    echo "  PABU_DIR=/opt/pabu ./${APP_NAME}.sh install"
    echo ""
}

main() {
    if [ "$MODE" = "remote" ] && [ -z "$1" ]; then
        do_install
        exit 0
    fi

    case "${1:-}" in
        install)    do_install ;;
        start)      do_start ;;
        stop)       do_stop ;;
        restart)    do_restart ;;
        status)     do_status ;;
        logs)       do_logs ;;
        update)     do_update ;;
        uninstall)  do_uninstall ;;
        enable)     do_enable ;;
        disable)    do_disable ;;
        help|--help|-h) show_help ;;
        *)
            if [ -n "$1" ]; then
                log_error "未知命令: $1"
            fi
            show_help
            exit 1
            ;;
    esac
}

main "$@"
