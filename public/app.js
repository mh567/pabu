((window) => {
    'use strict';

    const $ = (sel, ctx = document) => ctx.querySelector(sel);
    const $$ = (sel, ctx = document) => [...ctx.querySelectorAll(sel)];
    const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    const html = (str) => { const t = document.createElement('template'); t.innerHTML = str.trim(); return t.content.firstChild; };
    const uid = () => 'id_' + Math.random().toString(36).slice(2, 9);

    // ========== 端到端加密工具 ==========
    const Crypto = {
        // 文本分享 v2：取件码本身是 128 位随机密钥，服务端只拿到它的散列 ID。
        async importShareKey(code) {
            return crypto.subtle.importKey(
                'raw', ShareCode.keyBytes(code), 'AES-GCM', false, ['encrypt', 'decrypt']
            );
        },

        // 一期服务器中转文件仍用单词取件码派生 AES-GCM 密钥。
        // 取件页 public/file.html 的 deriveKey 使用同一组 PBKDF2 参数，
        // 两边必须逐字一致。文本分享 v2 改造时删掉过这里，
        // 结果是实时直连失败回退中转时上传直接抛 Crypto.deriveKey is not a function。
        async deriveKey(code) {
            const enc = new TextEncoder();
            const material = await crypto.subtle.importKey(
                'raw', enc.encode(code + '-pabu-e2e'), 'PBKDF2', false, ['deriveKey']
            );
            return crypto.subtle.deriveKey(
                { name: 'PBKDF2', salt: enc.encode('pabu-paste-v2'), iterations: 100000, hash: 'SHA-256' },
                material,
                { name: 'AES-GCM', length: 256 },
                false,
                ['encrypt', 'decrypt']
            );
        },

        async encryptWithCode(text, code) {
            const key = await this.importShareKey(code);
            const enc = new TextEncoder();
            const iv = crypto.getRandomValues(new Uint8Array(12));
            const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(text));
            const combined = new Uint8Array(iv.length + encrypted.byteLength);
            combined.set(iv);
            combined.set(new Uint8Array(encrypted), iv.length);
            let binary = '';
            for (const byte of combined) binary += String.fromCharCode(byte);
            return btoa(binary);
        }
    };


    // 口令 → 连接证明的用途/版本标签。**必须与 lib/sync-store.js 的 CONNECT_LABEL
    // 逐字一致**：两侧算出来的证明不同，服务端就定位不到空间，而症状只是
    // 「口令明明对，却说不存在空间」。有一条用例从两份源码里各解析出来对拍。
    const CONNECT_LABEL = 'pabu-space-connect-v1';
    // 口令长度按 **Unicode 码点** 计（见 App.validateSyncPassphrase），
    // 与设计文档的「6 至 128 个 Unicode 码点」一致。
    const SYNC_PASSPHRASE_MIN = 6;
    const SYNC_PASSPHRASE_MAX = 128;

    // 单次批量生成的邀请码上限。与服务端 lib/sync-store.js 的 INVITE_BATCH_MAX 同值，
    // 但**不是判据**：界面这一份只挡手滑（超了就地拦下并说明），真正的上限在 store
    // 里判——curl 不经过这个文件。两边同值是为了「提示里的数字」与「被拒时的数字」一致。
    const SYNC_INVITE_BATCH_MAX = 20;
    // 邀请码列表与空间列表的每页条数（服务端 limit 的默认值也是 20）。
    const SYNC_PAGE_SIZE = 20;

    // ========== 口令空间的自动同步参数 ==========
    //
    // 这些数是设计文档 §5 的默认值，别在方法体里散落魔法数字——它们同时被
    // 用例从源码解析出来（改这里，用例跟着算，不是手写死数）。
    const SYNC_DEBOUNCE_MS = 500;      // 本地改动合并窗口
    const SYNC_MAX_WAIT_MS = 2000;     // 连续改动时，首次上传的最长等待
    const SYNC_POLL_MS = 30000;        // 可见页面的检查周期
    const SYNC_BACKOFF_START_MS = 1000;    // 失败后退避起点
    const SYNC_BACKOFF_MAX_MS = 300000;    // 退避上限（5 分钟）
    const SYNC_CLAIM_TTL_MS = 15000;   // 上传认领的有效期（多标签页单飞；崩溃兜底）
    const SYNC_CLAIM_PING_MS = 300;    // 认领「问一声」的等待上限
    const SYNC_RECEIPT_WINDOW_MS = 86400000; // 服务端成功回执的保留窗口（24 小时）
    // 总暂停期间客户端的检查间隔。**必须与 lib/sync-store.js 的
    // SYNC_PAUSED_RETRY_MS 同值**：服务端把它放进 503 的 `Retry-After`，
    // 客户端按同一个数排队，两边才一致（改一边忘了另一边，症状是客户端要么
    // 比要求来得更勤、要么恢复后迟迟不回来）。有一条测试从两份源码解析后对拍。
    const SYNC_PAUSED_POLL_MS = 300000;

    // 状态的**完整**文案（对话框里用，设计文档 §5 那六个词）。
    const SYNC_STATUS_TEXT = {
        local: '仅保存在本机',
        syncing: '同步中',
        synced: '已同步',
        pending: '离线，待同步',
        failed: '同步失败',
        conflict: '存在配置冲突'
    };
    // 页脚那一行只有两个字的位置：`local` 仍然叫「同步」，因为那里是**入口**
    // （点进去连接），不是状态显示——写「仅保存在本机」会让人以为点不动。
    const SYNC_STATUS_LABEL = {
        local: '同步',
        syncing: '同步中',
        synced: '已同步',
        pending: '待同步',
        failed: '同步失败',
        conflict: '同步冲突'
    };

    // 管理端凭据由 HttpOnly Cookie 承载，JS 读不到也不需要读。
    // 服务端把「因环境变化被自动登出」用两种方式表达：401 响应体里的
    // code:'env_changed'，以及两处软门（200 响应）上的 X-Session-Env-Changed 头。
    // 软门必须返回 200——否则匿名用户每次刷新首页都会看到报错——
    // 但那样客户端就收不到原因，只能对着被截断的公开列表建索引。
    const API = {
        envChangeNotified: false,
        notifyEnvChanged(data, headers) {
            const fromBody = data && data.code === 'env_changed';
            const fromHeader = headers && headers.get('X-Session-Env-Changed') === 'env_changed';
            if (!fromBody && !fromHeader) return;
            if (API.envChangeNotified) return;
            API.envChangeNotified = true;
            if (window.app) {
                window.app.expirePrivateState();
                // 模块区与布局按钮是登录态的产物，必须一起收起。
                // 少了这一行，环境变化后首页仍留着可点的模块入口。
                window.app.showToast('检测到登录环境变化，已自动退出，请重新登录', 'error', 8000);
            }
        },
        /**
         * 把 `{ token }` 选项翻成 `Authorization: Bearer` 头。
         *
         * 设备令牌**只走请求头**，不进 URL：URL 会落到访问日志、Referer 与
         * 浏览器历史里，而这是一枚能读写整个空间的凭据。
         */
        authOptions(options) {
            if (!options || !options.token) return options || {};
            const { token, ...rest } = options;
            return { ...rest, headers: { ...rest.headers, Authorization: `Bearer ${token}` } };
        },
        // binary=true 时不碰 body，把流留给调用方用 res.blob() 读。
        // 否则一律在此解析：body stream 只能读一次，调用方再 res.json()
        // 会抛 "body stream already read"。
        async request(url, options, binary = false) {
            const adminRequest = url.startsWith('/api/admin/') || url === '/api/session';
            if (url.startsWith('/api/admin/') && !window.app?.authenticated) throw new Error('需要管理员登录');
            const epoch = adminRequest ? (window.app?.privateEpoch || 0) : null;
            const res = await fetch(url, { credentials: 'same-origin', ...options, headers: { ...options?.headers, 'X-Pabu-Request': '1' } });
            if (adminRequest && epoch !== (window.app?.privateEpoch || 0)) throw new Error('登录状态已变化');
            if (adminRequest && res.status === 401 && window.app?.authenticated) {
                window.app.expirePrivateState();
            }
            if (adminRequest && epoch !== (window.app?.privateEpoch || 0)) throw new Error('登录状态已变化');
            if (binary) return { res, data: null };
            let data = null;
            try { data = await res.json(); } catch (e) {}
            if (adminRequest && epoch !== (window.app?.privateEpoch || 0)) throw new Error('登录状态已变化');
            // 200 的响应也可能带 env_changed（软门），所以不看状态码，只看两个信号源
            API.notifyEnvChanged(data, res.headers);
            return { res, data };
        },
        async get(url, options = {}) {
            const { res, data } = await API.request(url, API.authOptions(options));
            // 带上状态码：调用方要能区分「请求过于频繁（429）」与「真的读不到」。
            // 混成一句话会让用户完全找不到下一步——同一个限流桶曾同时表现为
            // 「模块加载不出来」与「监控数据读取失败」两种听起来无关的症状。
            if (!res.ok) {
                // `code` 和状态码一起带出来：服务端把「空间已删」「本设备被撤销」
                // 「令牌过期」「空间停用」分开返回，客户端要按码给不同的话和不同
                // 的下一步。读路径（30 秒轮询）往往是最先撞上这些的那个。
                throw Object.assign(new Error(data?.error || res.statusText || `HTTP ${res.status}`), { status: res.status, code: data?.code, data });
            }
            return data;
        },
        async post(url, body, options = {}) {
            const auth = API.authOptions(options);
            const { res, data } = await API.request(url, {
                ...auth,
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...auth.headers },
                body: JSON.stringify(body)
            });
            if (!res.ok && data && data.error) {
                // 带业务码抛错：口令空间那几条要按 code 区分
                // 「邀请码用过了」「云端版本变了」「连接材料失效」，
                // 只给一句 HTTP 文案的话调用方分不出下一步该做什么。
                throw Object.assign(new Error(data.error), { status: res.status, code: data.code });
            }
            return data || {};
        }
    };

    // 外观三态，与后台「主题模式」下拉框同一套取值。
    // 未登录访客的选择存在本机；这个键名在 index.html 的内联脚本里也出现
    // （那里要抢在样式表之前把它应用上，避免首屏闪一下系统色），
    // 两处必须一致——tests 里有跨文件断言钉住。
    const THEME_STORAGE_KEY = 'pabu-theme';
    const LOCAL_SETTINGS_FIELDS = ['searchEngine', 'searchEngines', 'theme', 'themeStyle', 'showBookmarkIcons'];
    const APPEARANCE_ORDER = ['auto', 'light', 'dark'];
    // 下拉菜单共享的最小宽度。实际宽度取触发控件宽度与该值的较大者。
    // 120px 足以容纳最长的 DuckDuckGo（73px 文本 + 选项和菜单内边距）。
    const DROPDOWN_MIN_WIDTH = 120;

    class App {
        constructor() {
            this.adminPage = location.pathname === '/admin' || location.pathname === '/admin/';
            this.config = null;
            this.authenticated = false;
            // 当前会话是否被信任（可信=30 天，否则 24 小时）
            this.sessionTrusted = false;
            this.dragData = null;
            this.pasteMode = false;
            this.pasteUserResized = false;
            // 文件上传在途：关闭或刷新会让已上传分片作废，beforeunload 需要拦一下。
            this.transferActive = false;
            // 首页取件码识别：记住被 Esc 取消过的**归一化后的码**（不是原始输入）。
            // 记码而不是记一个布尔，换一个码就自动重新生效，不需要在登录、
            // 模式切换这些事件上「重新武装」，也就不会留下永久失效的一次性标志。
            this.pickupDismissedCode = null;
            this.configDirty = false;
            this.configSaving = false;
            this.configSnapshot = null;
            // 站点默认导航：只在 /admin 的一比一画布里编辑，与首页本地导航完全独立。
            this.siteConfig = null;
            this.siteSurface = null;
            this.siteLoaded = false;
            this.suspendedSiteDraft = null;
            this.toastTimer = null;
            // 性能优化
            // 版本管理
            // 模块配置的来源：'server'（管理员，存服务端）或 'local'（普通访客，存本机）。
            // 只有两个 I/O 边界（loadModulesConfig / saveModulesConfig）按它分叉，
            // 布局与拖拽那一段完全不关心来源。
            // 本机模块记录（普通访客的开关 / 布局 / 偏好）与它的乐观并发基线。
            // 公开模块策略：管理员把哪些公开模块对外开放了。null = 未知。
            // 未知时一个公开模块都不加载——「未知授权不加载」。
            // 普通口令空间。this.syncProof 是这次流程里口令派生出的连接证明，
            // **只在内存里**，关掉对话框即清——它等价于口令，不进任何持久存储。
            this.syncConnection = null;
            this.syncCloud = null;
            this.syncRecovery = null;
            this.syncRecordRevision = 0;
            this.syncState = 'disconnected';
            this.syncBusy = false;
            this.syncError = '';
            this.syncSpaceInfo = null;
            // 服务端当前的邀请策略：来自 `/api/sync/space/check` 的响应。默认 true
            // 是旧服务端的语义，也避免响应慢时把「需要邀请码」误判成不需要。
            this.syncInviteRequired = true;
            this.syncProof = null;
            // 对话框节点：临开临建、关掉就删。不能常驻——`.ui-dialog-overlay`
            // 在本文件里是「有没有对话框开着」的判据（见 openSyncDialog 的注释）。
            this.syncDialogEl = null;
            // ---- 自动同步（与上面那个「连接流程」状态机是**两个轴**）----
            // syncStatus 是数据面的状态（设计文档 §5 的六个词）；syncState 是
            // 对话框流程走到哪一步。别把它们合并成一个字段。
            this.syncStatus = 'local';
            this.syncLastSuccessAt = null;
            this.syncCloud = null;        // 已知的云端状态（revision/generation/updatedAt）
            this.syncPending = null;      // 盘上那份待上传内容的镜像
            this.syncClaim = null;
            this.syncConflict = null;     // { local, cloud, baseRevision }
            // 本机的**连接代次**：连接、清除连接时 +1。在飞的读/写响应发现自己
            // 发起时的代次已经变了就作废——「停止/切换后旧响应不许写回」靠它，
            // 与管理员侧的 privateEpoch 是同一个形状。
            this.syncConnEpoch = 0;
            // 身份是否还在确认中：确认为真期间**不跑普通同步**（设计 §4.1）。
            // 探测失败时保持为真——「确认不了」不能当成「是匿名」。
            this.identityPending = true;
            // 服务端说这台空间被停用 / 同步服务被总暂停时置上：停自动重试，等用户主动
            // 点「重试同步」或管理员恢复。不置的话会对着一个 403/503 无限退避。
            // 取值 `null`（没暂停）/ `'disabled'`（该空间被停用）/ `'paused'`（总暂停）：
            // 两种暂停的对话框文案不同，所以要记住是哪一种（见 applySyncHalt）。
            this.syncHalted = null;
            this.syncPollMs = SYNC_POLL_MS;
            // 「撤销全部旧设备」的稳定请求 ID：**只在内存里**（见 confirmResetDevices 的注释），
            // 一次确认里的重试复用，关掉对话框/刷新就换新的。
            this.syncResetOperationId = null;
            this.syncUploadInFlight = false;
            this.syncUploadAgain = false; // 在途期间又有改动 → 完成后排下一轮
            this.syncUploadSettled = false; // 本次上传已确认 → 放下在途闩后再读一次
            // 最近一次确认上传成功时**内容**的指纹（见 syncPayloadKey）。「已同步」只在
            // 它等于当前内容指纹时成立——否则「本地刚改过」也会显示已同步（验收 6 禁止）。
            this.syncUploadedPayloadKey = null;
            this.syncDebounceTimer = null;
            this.syncMaxWaitTimer = null;
            this.syncRetryTimer = null;
            this.syncBackoffMs = 0;
            this.syncPollTimer = null;
            this.syncChecking = false;
            this.syncAdopting = false;    // 正在采用云端配置（这次保存不算「本地新改动」）
            this.syncChannel = null;
            this.syncTabId = null;
            // 管理员「站点」分区里的邀请码列表：缓存 + 「已渲染」闩锁。
            this.syncInvites = null;
            this.syncInvitesRendered = false;
            // 同步空间治理（#10）：列表/用量/策略三份缓存 + **独立的「已渲染」闩锁**。
            // ⚠️ 闩锁与邀请码那个**分开**：两者挂在同一个分区里，但加载时机与失败路径
            // 各自独立——共用一个闩锁会让「邀请码加载失败」顺带把空间列表钉在
            // 「加载中…」上（反之亦然）。
            this.syncSpaces = null;
            this.syncUsage = null;
            this.syncPolicy = null;
            this.syncSpacesRendered = false;
            // 「同步管理」tab 的筛选 / 分页 / 勾选状态。**留在内存里**：切走切回保留现场
            // （当前筛选、页码、勾选都在），面板重建时只复位上面那两只闩锁。
            this.syncInvitesFilter = { state: 'all', offset: 0, limit: SYNC_PAGE_SIZE };
            this.syncInvitePage = null;       // 服务端的 page（total/offset/limit）
            this.syncInviteCounts = null;     // 服务端的 counts（四种状态各几张）
            this.syncInviteBatch = null;      // 本次批量生成的结果：只在这一次显示
            this.syncInviteSelected = new Set();
            this.syncSpacesFilter = { q: '', state: 'all', sort: 'updated', offset: 0, limit: SYNC_PAGE_SIZE };
            this.syncSpacesPage = null;
            this.syncSpacesSelected = new Set();
            this.syncSpacesSearchTimer = null;   // 搜索输入的防抖定时器
            this.syncSpacesClamping = false;     // 页码越界回退只做一次，防止来回拉
            // 身份或策略代次。在飞的模块区渲染发现它变了就作废
            // （管理员那侧另有 privateEpoch 管登录态变化）。
            // 已挂载的模块 id。某模块离开启用集合时要通知它收掉自己的定时器。
            // 未启用模块被用户点开「展开配置」的那些 id。面板重建时清空，
            // 同一面板内的重渲染（探测/编辑/删除触发）保留——否则用户刚
            // 展开、卡片一刷新又收起来了。
            // 远程备份区块：配置缓存 + 「有没有渲染进当前这块 DOM」的闩锁。
            // 判据必须是后者。面板每次 openAdmin / 重渲染都会重建 #modalBody，
            this.editLayout = false;
            // 网格上一次渲染时是否处于编辑态。显式初始化而不是靠 undefined
            // 与 false 的隐式比较：syncEditLayoutUI 靠它判断「状态真的翻转了」，
            // 而 undefined !== false 成立纯属巧合。
            this._gridEditing = false;
            // 同一帧内多次纵向重排请求合并成一个（见 requestWidgetStack）。
            // 与 _gridEditing 同理显式初始化，不靠 undefined 的隐式比较。
            // 首页网格的编辑表面，配置来自用户本机导航；每次变更都自动落本机。
            this.homeSurface = this.gridSurface({
                getConfig: () => this.config,
                isEditing: () => this.editLayout,
                host: $('#grid'),
                changed: this.saveLocalNavigation.bind(this)
            });
            this.initBookmarkIcons();
            this.init();
        }

        // 按需加载一个 <script>。同一 src 只加载一次，后续调用复用同一 promise。
        // 用于把非首屏必需的库（拼音搜索、分享二维码）移出首屏关键路径。
        loadScript(src) {
            return new Promise((resolve, reject) => {
                const script = document.createElement('script');
                script.src = src;
                script.onload = resolve;
                script.onerror = () => reject(new Error('加载失败: ' + src));
                document.head.appendChild(script);
            });
        }

        async toggleEditLayout() {
            if (this.themeStyleSaving) return;
            if (this.editLayout) return this.saveEditSession();
            this.editLayout = true;
            this.renderLocalSettings();
            this.syncEditLayoutUI();
        }

        syncEditEntries() {
            const editing = this.editLayout;
            this.renderHomeThemeSwitcher();
            const btn = $('#layoutBtn');
            if (btn) {
                btn.hidden = editing;
                btn.setAttribute('aria-pressed', String(editing));
            }
            const cancel = $('#localCancelBtn');
            if (cancel) cancel.hidden = !editing;
            const save = $('#localDoneBtn');
            if (save) {
                save.hidden = !editing;
                save.textContent = '保存配置';
                save.title = '保存导航设置并退出编辑';
            }
        }

        /**
         * 同步入口始终显示。
         */
        syncFooterEntries() {
            const syncSep = $('#syncSep');
            if (syncSep) syncSep.hidden = false;
            this.markSyncEntry();
        }

        syncEditLayoutUI() {
            const grid = $('#grid');
            const editing = this.editLayout;
            this.syncEditEntries();
            const tools = $('#localNavigationTools');
            if (tools) this.setLocalSettingsVisible(editing);
            const status = $('#localNavigationStatus');
            if (status) status.hidden = !editing && !this.localStatusError;
            const engine = $('#engineBtn');
            if (engine) {
                engine.disabled = editing;
                engine.title = editing ? '在下方设置默认搜索引擎' : '切换搜索引擎';
            }
            this.syncFooterEntries();
            if (grid) grid.classList.toggle('is-editing', editing);
            if (grid && this._gridEditing !== editing) { this._gridEditing = editing; this.renderGrid(); }
        }

        async saveEditSession() {
            if (this.localSettingsSaving) return;
            this.localSettingsSaving = true;
            $('#localSettingsForm').inert = true;
            $('#grid').inert = true;
            $('#engineBtn').disabled = true;
            $('#localDoneBtn').disabled = true;
            $('#localSettingsError').hidden = true;
            this.setLocalStatus('正在保存到本机');
            try {
                await this.localQueue;
                const candidate = this.localNavigationCandidate();
                window.NavigationSchema.validate(candidate);
                if (JSON.stringify(candidate) !== JSON.stringify(this.localSaved) || this.localError) {
                    if (!await this.saveLocalNavigation(candidate)) return;
                }
                this.setLocalStatus('仅保存在本机');
                this.config = candidate;
                this.applyTheme();
                this.render();
                this.localSettingsDraft = null;
                this.exitEditLayout();
                $('#layoutBtn').focus();
                this.showToast('导航设置已保存到本机');
            } catch (error) {
                $('#localSettingsError').textContent = error.message;
                $('#localSettingsError').hidden = false;
                this.setLocalDrawerOpen(true);
            } finally {
                this.localSettingsSaving = false;
                $('#localSettingsForm').inert = false;
                $('#grid').inert = false;
                $('#engineBtn').disabled = this.editLayout;
                $('#localDoneBtn').disabled = false;
                if (!$('#localSettingsError').hidden) $('#localSettingsError').focus();
            }
        }

        async cancelEditSession() {
            if (this.localSettingsSaving) return;
            if (this.localSettingsChanged() && !await this.confirmAction('放弃尚未保存的导航设置？已保存的分类与链接调整会保留。', '取消设置')) return;
            this.localSettingsDraft = null;
            this.setLocalStatus(this.localError || '仅保存在本机', !!this.localError);
            this.exitEditLayout();
            $('#layoutBtn').focus();
            this.refreshLocalNavigation();
        }

        exitEditLayout() {
            this.editLayout = false;
            this.syncEditLayoutUI();
            $('#grid').querySelectorAll('.is-dragging, .drop-target').forEach(node => node.classList.remove('is-dragging', 'drop-target'));
            this.dragData = null;
        }

        setLocalStatus(message, error = false) {
            const status = $('#localNavigationStatus');
            if (status) {
                status.textContent = message;
                const quiet = !error && (message === '仅保存在本机' || message === '正在保存到本机');
                status.hidden = quiet || (!this.editLayout && !error);
                this.localStatusError = error;
                status.dataset.state = error ? 'error' : '';
            }
            const tools = $('#localNavigationTools');
            if (tools) tools.dataset.state = error ? 'error' : '';
        }

        async loadLocalNavigation() {
            this.localStore = new window.LocalNavigation();
            this.localQueue = Promise.resolve();
            this.localPending = 0;
            let record;
            try { record = await this.localStore.read(); }
            catch (error) {
                this.localUnavailable = true;
                this.localError = '未能保存到本机：' + error.message;
            }
            if (!record) {
                const config = await (window.__navPabuConfigPromise || API.get('/api/config'));
                try { const legacy = localStorage.getItem(THEME_STORAGE_KEY); if (APPEARANCE_ORDER.includes(legacy)) config.theme = legacy; } catch (e) {}
                window.NavigationSchema.validate(config);
                if (!this.localUnavailable) {
                    try { record = await this.localStore.write(config, 0); }
                    catch (error) {
                        // 另一个首次访问标签页可能已经建立了副本。
                        record = await this.localStore.read();
                        if (!record) { this.localUnavailable = true; this.localError = '未能保存到本机：' + error.message; }
                    }
                }
                this.config = structuredClone(record?.config || config);
            } else this.config = structuredClone(record.config);
            if (record) { try { localStorage.removeItem(THEME_STORAGE_KEY); } catch (e) {} }
            this.localRevision = record?.revision || 0;
            this.localSaved = structuredClone(record?.config || this.config);
        }

        saveLocalNavigation(config = this.config, undo = false) {
            const candidate = window.NavigationSchema.publicConfig(structuredClone(config));
            this.localPending++;
            this.setLocalStatus('正在保存到本机');
            const task = this.localQueue.then(async () => {
                try {
                    if (this.localUnavailable) throw new Error('本地存储不可用，请导出导航保留副本');
                    const record = await this.localStore.write(candidate, this.localRevision, undo);
                    this.localRevision = record.revision;
                    this.localSaved = structuredClone(record.config);
                    this.localError = null;
                    if (undo) { this.config = structuredClone(record.config); this.applyTheme(); this.render(); if (this.editLayout) this.renderLocalSettings(); }
                    this.localChannel?.postMessage(record.revision);
                    this.setLocalStatus('仅保存在本机');
                    // 同步的唯一触发点：**本地真的落盘之后**才排上传。
                    // 挂在编辑动作里会散成很多处，且会在没保存成功时就发出去。
                    this.markSyncDirty();
                    return true;
                } catch (error) {
                    this.localError = '未能保存到本机：' + error.message;
                    if (error.code === 'conflict') $('#localAdoptBtn').hidden = false;
                    this.setLocalStatus(this.localError, true);
                    this.showToast(this.localError, 'error', 8000);
                    return false;
                } finally { this.localPending--; }
            });
            this.localQueue = task;
            return task;
        }

        async refreshLocalNavigation(adopt = false) {
            if (this.localPending) return;
            try {
                const record = await this.localStore.read();
                if (this.localPending || !record || record.revision === this.localRevision) return;
                if (!adopt && (this.editLayout || $('.ui-dialog-overlay') || this.localError)) {
                    this.setLocalStatus('其他标签页已修改导航，当前输入已保留。请先导出或采用其他标签页版本。', true);
                    $('#localAdoptBtn').hidden = false;
                    return;
                }
                this.localRevision = record.revision;
                this.localSaved = structuredClone(record.config);
                this.config = structuredClone(record.config);
                this.localError = null;
                $('#localAdoptBtn').hidden = true;
                this.applyTheme(); this.render();
                this.setLocalStatus('仅保存在本机');
            } catch (error) { this.setLocalStatus('无法读取本地导航：' + error.message, true); }
        }

        exportLocalNavigation() {
            const blob = new Blob([JSON.stringify({ schemaVersion: 1, config: window.NavigationSchema.publicConfig(this.localNavigationCandidate()) }, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url; link.download = 'pabu-navigation.json'; link.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        }

        async importLocalNavigation(file) {
            if (!file) return;
            const revision = this.localRevision;
            try {
                if (file.size > 1024 * 1024) throw new Error('配置超过 1 MiB');
                const data = JSON.parse(await file.text());
                if (data.schemaVersion !== 1 || Object.keys(data).some(k => !['schemaVersion', 'config'].includes(k))) throw new Error('配置文件版本或字段无效');
                const config = data.config;
                if (Array.isArray(config?.searchEngines) && config.searchEngines.length && !config.searchEngines.some(e => e.id === config.searchEngine)) config.searchEngine = config.searchEngines[0].id;
                window.NavigationSchema.validate(config);
                if (!await this.confirmAction('导入将替换本机导航，可通过撤销恢复上一份配置。', '导入导航')) return;
                if (this.localRevision !== revision) throw new Error('导航状态已变化，请重新导入');
                if (await this.saveLocalNavigation(config)) { this.config = structuredClone(config); this.applyTheme(); this.render(); if (this.editLayout) this.renderLocalSettings(); }
            } catch (error) { this.showToast('导入失败：' + error.message, 'error'); }
        }

        async resetLocalNavigation() {
            const revision = this.localRevision;
            try {
                const config = await API.get('/api/config');
                window.NavigationSchema.validate(config);
                if (!await this.confirmAction('用当前站点导航替换本机导航及未保存设置？可通过撤销恢复。', '重置导航')) return;
                if (this.localRevision !== revision) throw new Error('导航状态已变化，请重新重置');
                if (await this.saveLocalNavigation(config)) { this.config = structuredClone(config); this.applyTheme(); this.render(); if (this.editLayout) this.renderLocalSettings(); }
            } catch (error) { this.showToast('重置失败，原导航已保留：' + error.message, 'error'); }
        }

        localNavigationCandidate() {
            const candidate = window.NavigationSchema.publicConfig(structuredClone(this.config));
            if (this.localSettingsDraft) for (const key of LOCAL_SETTINGS_FIELDS) candidate[key] = structuredClone(this.localSettingsDraft[key]);
            return candidate;
        }

        // ==================== 普通口令云端空间 ====================
        //
        // 与管理员那套（服务端管理员配置 + 会话）完全独立：这里的凭据是**用户
        // 自设的口令**派生出的连接证明 + 签发下来的设备令牌，普通访客无需登录。
        //
        // 三条不能改坏的约定（都在用例里钉着）：
        //   1. 口令**只**在内存里，且只在这一次流程内（this.syncProof）。
        //      不写 IndexedDB、不写 localStorage、不回显到任何 DOM 值里。
        //   2. 设备令牌落 IndexedDB（同库第三个键），**先写成功再置「已连接」**——
        //      反过来的话，存储失败时用户会看到已连接，下次打开却是未连接。
        //   3. 两个替换方向都要先留下被替换的那一份（this.syncRecovery），
        //      且上传方向基于检查时拿到的 revision，冲突就回来重选。

        /** 口令校验：6–128 个 **Unicode 码点**，不裁空格、不归一化，全空白拒绝。 */
        validateSyncPassphrase(value) {
            if (typeof value !== 'string' || value.length === 0) return { ok: false, reason: '请输入口令' };
            // Array.from 按码点迭代：emoji（代理对）与带组合符的字符都算 1 个。
            // 用 value.length 会把它算成 2，于是「6 个字符」在中文/emoji 下会误判。
            const points = Array.from(value).length;
            if (!/\S/u.test(value)) return { ok: false, reason: '口令不能全是空白字符' };
            if (points < SYNC_PASSPHRASE_MIN) return { ok: false, reason: `口令至少 ${SYNC_PASSPHRASE_MIN} 个字符` };
            if (points > SYNC_PASSPHRASE_MAX) return { ok: false, reason: `口令最多 ${SYNC_PASSPHRASE_MAX} 个字符` };
            return { ok: true };
        }

        /**
         * 口令 → 连接证明（64 位十六进制）。
         *
         * 标签里同时带**用途**（space-connect）和**版本**（v1）：换用途或换版本就是
         * 换标签，同一个口令算出来的证明不同，服务端因此定位不到旧空间——不需要
         * 额外的命名空间字段。标签必须与 lib/sync-store.js 的 CONNECT_LABEL 逐字一致。
         *
         * 需要安全上下文（HTTPS 或 localhost）：纯 http 的局域网访问下
         * `crypto.subtle` 不存在，这里明确报错而不是退回明文。
         */
        async deriveSyncProof(passphrase) {
            if (!window.crypto || !window.crypto.subtle) throw new Error('当前访问方式无法安全派生口令，请通过 HTTPS 或 localhost 访问');
            const bytes = new TextEncoder().encode(`${CONNECT_LABEL}\u0000${passphrase}`);
            const digest = await window.crypto.subtle.digest('SHA-256', bytes);
            return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
        }

        // ---- 管理员：同步管理 · 邀请码 ----
        //
        // 四个动作：批量生成、列出（状态筛选 + 分页 + 计数）、单张撤销、批量撤销。
        // 列表**只显示提示（前 4 位）**：库里存的是哈希，完整码只在生成的响应里出现
        // 一次（`#syncInviteBatch` 那块结果区），离开这一页就再也看不到。

        /** 邀请码列表的查询串：只带非默认值，「全部 / 第 1 页」的 URL 最短。 */
        syncInvitesQuery() {
            const filter = this.syncInvitesFilter || { state: 'all', offset: 0, limit: SYNC_PAGE_SIZE };
            const params = [];
            if (filter.state && filter.state !== 'all') params.push(`state=${encodeURIComponent(filter.state)}`);
            if (filter.offset > 0) params.push(`offset=${filter.offset}`);
            params.push(`limit=${filter.limit || SYNC_PAGE_SIZE}`);
            return `?${params.join('&')}`;
        }

        /**
         * 拉一页邀请码并重画。
         *
         * ⚠️ **一条 GET**：筛选项、页码、计数、列表全来自这一个响应。分成几条的话，
         * 每切一次筛选都要多打几条管理接口，而管理桶只有 30 次/分钟（本仓库已经
         * 因为「渲染里顺手预取」撞过 429）。
         */
        async renderSyncInvites() {
            const list = $('#syncInviteList');
            if (!list) return;
            try {
                const url = '/api/admin/sync-invites' + this.syncInvitesQuery();
                const data = await API.get(url);
                this.syncInvites = data.invites || [];
                this.syncInvitePage = data.page || { total: this.syncInvites.length, offset: 0, limit: SYNC_PAGE_SIZE };
                this.syncInviteCounts = data.counts || null;
                this.syncInvitesRendered = true;
                this.paintSyncInvites();
                this.paintSyncInviteBatch();
            } catch (error) {
                this.syncInvitesRendered = false;
                list.innerHTML = `<p class="fav-hint">邀请码读取失败：${this.esc(error.message)}</p>
                    <button type="button" class="btn btn-sm" data-action="retry-invites">重试</button>`;
            }
        }

        /** 邀请码列表 + 计数行 + 分页（**不发请求**）。 */
        paintSyncInvites() {
            const list = $('#syncInviteList');
            const page = this.syncInvitePage || { total: 0, offset: 0, limit: SYNC_PAGE_SIZE };
            const counts = this.syncInviteCounts;
            const countRow = $('#syncInviteCounts');
            if (countRow) {
                // 计数行说的是**全实例**的四个数（服务端的 counts），不是本页——
                // 否则「已使用 0 张」会在翻到第 2 页时凭空变出来。
                countRow.textContent = counts
                    ? `未使用 ${counts.unused} 张 · 已使用 ${counts.used} 张 · 已过期 ${counts.expired} 张 · 已撤销 ${counts.revoked} 张`
                    : '';
            }
            const pager = $('#syncInvitePager');
            if (pager) {
                const perPage = page.limit || SYNC_PAGE_SIZE;
                // 一页装得下就不画上一页/下一页：只有几张码时那行是纯噪音。
                pager.hidden = page.total <= perPage;
                pager.innerHTML = `<button type="button" class="btn btn-sm" data-action="invites-prev" ${page.offset <= 0 ? 'disabled' : ''}>上一页</button>
                    <span class="sync-pager-page">第 ${Math.floor(page.offset / perPage) + 1} / ${Math.max(1, Math.ceil(page.total / perPage))} 页</span>
                    <button type="button" class="btn btn-sm" data-action="invites-next" ${page.offset + perPage >= page.total ? 'disabled' : ''}>下一页</button>`;
            }
            if (!list) return;
            const invites = this.syncInvites || [];
            if (!invites.length) {
                const filtered = this.syncInvitesFilter && this.syncInvitesFilter.state !== 'all';
                list.innerHTML = `<p class="fav-hint">${filtered ? '这个状态下没有邀请码。' : '还没有邀请码。生成一批发给要创建空间的人。'}</p>`;
                this.updateSyncInviteBulk();
                return;
            }
            list.innerHTML = invites.map(invite => {
                const stale = invite.revoked || invite.expired || invite.used;
                const state = invite.used ? `已使用 ${this.esc(this.syncRelTime(invite.usedAt))}`
                    : invite.revoked ? '已撤销'
                        : invite.expired ? '已过期'
                            : `有效至 ${this.esc(new Date(invite.expiresAt).toLocaleString())}`;
                const action = stale ? ''
                    : `<button type="button" class="btn btn-sm" data-action="revoke-invite" data-id="${this.esc(invite.id)}">撤销</button>`;
                // 只有**未使用且未过期**的能批量撤销（服务端的 WHERE 也是这个判据），
                // 其余行的复选框直接禁用——点得动却撤不掉是最糟的一种界面。
                const selectable = invite.state === 'unused';
                return `<div class="sync-invite-row${stale ? ' is-stale' : ''}">
                    <input type="checkbox" data-select-invite="${this.esc(invite.id)}" aria-label="选择邀请码 ${this.esc(invite.hint)}" ${selectable ? '' : 'disabled'} ${this.syncInviteSelected.has(String(invite.id)) ? 'checked' : ''}>
                    <code>${this.esc(invite.hint)}-····-…</code>
                    <span>${this.esc(invite.note || "")}</span><span class="sync-invite-state">${state}</span>${action}
                </div>`;
            }).join('');
            this.updateSyncInviteBulk();
        }

        /** 勾选一张邀请码（复选框的 change 事件，走委托）。 */
        toggleSyncInviteSelection(id, checked) {
            const key = String(id || '');
            if (!key) return;
            if (checked) this.syncInviteSelected.add(key); else this.syncInviteSelected.delete(key);
            this.updateSyncInviteBulk();
        }

        /** 「撤销选中」按钮：选中 0 张时禁用，并说出选了几张。 */
        updateSyncInviteBulk() {
            const button = $('#revokeSelectedInvites');
            if (!button) return;
            const count = this.syncInviteSelected.size;
            button.disabled = count === 0;
            button.textContent = count ? `撤销选中（${count}）` : '撤销选中';
        }

        /**
         * 本次要生成的张数：下拉的预设值，或「自定义…」输入框里的数字。
         *
         * 上限 (`SYNC_INVITE_BATCH_MAX` = 20) **在界面就拦**并说清为什么——让用户
         * 按一次得到一个说明，比让接口回 400 再由 toast 转述要好（也更早知道
         * 该分几次）。真正的判据仍在服务端：这里挡不住 curl。
         */
        syncInviteBatchCount() {
            const select = $('#syncInviteCount');
            const custom = $('#syncInviteCustomCount');
            const preset = select ? select.value : '10';
            const raw = preset === 'custom' ? (custom ? custom.value : '') : preset;
            const count = Number(String(raw).trim());
            if (!Number.isInteger(count) || count < 1) {
                return { ok: false, reason: `请填写要生成的张数（1–${SYNC_INVITE_BATCH_MAX}）` };
            }
            if (count > SYNC_INVITE_BATCH_MAX) {
                return { ok: false, reason: `单次最多生成 ${SYNC_INVITE_BATCH_MAX} 张，请分几次生成` };
            }
            return { ok: true, count };
        }

        /** 结果区/工具栏里的错误行（就地说明，不用 toast——用户要能边看边改）。 */
        showSyncInviteError(message) {
            const host = $('#syncInviteError');
            if (!host) return;
            host.textContent = message || '';
            host.hidden = !message;
        }

        /** 批量生成。码只出现在响应里一次，所以结果区必须当场把它画出来。 */
        async createSyncInvites(single = false) {
            const target = single ? { ok: true, count: 1 } : this.syncInviteBatchCount();
            if (!target.ok) { this.showSyncInviteError(target.reason); return; }
            const button = single ? $('#createSingleInviteBtn') : $('#createInviteBtn');
            const buttons = [$('#createSingleInviteBtn'), $('#createInviteBtn')];
            if (buttons.some(item => item && item.disabled)) return;
            buttons.forEach(item => { if (item) item.disabled = true; });
            this.showSyncInviteError('');
            if (button) { button.disabled = true; button.textContent = '生成中…'; }
            try {
                const result = await API.post('/api/admin/sync-invites/batch', { count: target.count, note: $('#syncInviteNote').value.trim() });
                this.syncInviteBatch = result.invites || [];
                this.paintSyncInviteBatch();
                // 新码排在最前：回到第一页重新拉一次。列表里的每一行只有 hint，
                // 靠它核对不了「刚生成的这批」，所以结果区才是唯一的交付物。
                this.syncInvitesFilter.offset = 0;
                await this.renderSyncInvites();
                this.showToast(`已生成 ${this.syncInviteBatch.length} 张邀请码`);
            } catch (error) {
                this.showSyncInviteError('生成失败：' + error.message);
            } finally {
                buttons.forEach(item => { if (item) item.disabled = false; });
                if (button) button.textContent = single ? '单个生成' : '批量生成';
            }
        }

        /** 本次生成的结果区：只显示这一次（面板重建即清空，见 renderAdminPanel）。 */
        paintSyncInviteBatch() {
            const host = $('#syncInviteBatch');
            if (!host) return;
            const batch = this.syncInviteBatch || [];
            if (!batch.length) { host.hidden = true; host.innerHTML = ''; return; }
            host.hidden = false;
            host.innerHTML = `<p class="sync-banner">本次生成 <strong>${batch.length}</strong> 张。现在复制或下载，关闭这一页后无法再查看。</p>
                <div class="sync-toolbar">
                    <button type="button" class="btn btn-sm" data-action="copy-invite-batch">复制全部</button>
                    <button type="button" class="btn btn-sm" data-action="download-invite-batch">下载 .txt</button>
                </div>
                <div class="sync-codes">${batch.map(invite => `<div class="sync-code"><code>${this.esc(invite.code)}</code><small>${this.esc(new Date(invite.expiresAt).toLocaleString())} 到期</small></div>`).join('')}</div>`;
        }

        /** 纯文本形状（复制与下载共用一份）：每行「码 + 到期时间」。 */
        syncInviteBatchText() {
            const batch = this.syncInviteBatch || [];
            const head = `Pabu 同步空间邀请码（${batch.length} 张，48 小时内有效，每张只能创建一个空间）`;
            return [head, ...batch.map(invite => `${invite.code}\t${new Date(invite.expiresAt).toLocaleString()} 到期`)].join('\n');
        }

        async copySyncInviteBatch() {
            const text = this.syncInviteBatchText();
            try {
                if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error('当前浏览器不允许写入剪贴板');
                await navigator.clipboard.writeText(text);
                this.showToast('已复制全部邀请码');
            } catch (error) {
                this.showToast('复制失败，请手动选中文本：' + error.message, 'error');
            }
        }

        downloadSyncInviteBatch() {
            const blob = new Blob([this.syncInviteBatchText()], { type: 'text/plain;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = `sync-invites-${new Date().toISOString().slice(0, 10)}.txt`;
            document.body.appendChild(link);
            link.click();
            link.remove();
            // 立刻 revoke 会让部分浏览器在下载开始前就丢掉 blob，下一拍再回收。
            setTimeout(() => URL.revokeObjectURL(url), 0);
            this.showToast('已下载邀请码文件');
        }

        /**
         * 批量撤销选中的邀请码。
         *
         * 只撤「未使用且未过期」的那几张——判据在服务端的 WHERE 里（先查后写会在
         * 两个管理员同时点的时候漏判），界面这里只保证**送上去的是选中的 id**，
         * 并把服务端回的**实际改动行数**说出来，而不是「选了几张就说撤了几张」。
         */
        async revokeSelectedInvites() {
            const ids = [...this.syncInviteSelected];
            if (!ids.length) return;
            if (!await this.confirmAction(`撤销选中的 ${ids.length} 张邀请码？只有尚未使用、尚未过期的会被撤销。`, '撤销邀请码', true)) return;
            const button = $('#revokeSelectedInvites');
            if (button) button.disabled = true;
            try {
                const result = await API.post('/api/admin/sync-invites/revoke', { ids });
                this.syncInviteSelected.clear();
                await this.renderSyncInvites();
                const revoked = Number(result && result.revoked) || 0;
                this.showToast(revoked === ids.length
                    ? `已撤销 ${revoked} 张邀请码`
                    : `已撤销 ${revoked} 张（其余 ${ids.length - revoked} 张已被使用或过期）`);
            } catch (error) {
                this.showToast('批量撤销失败：' + error.message, 'error');
            } finally {
                this.updateSyncInviteBulk();
            }
        }

        /** 单张撤销（既有能力保留）：列表每行那个「撤销」。 */
        async revokeSyncInvite(id) {
            try {
                await API.post(`/api/admin/sync-invites/${encodeURIComponent(id)}/revoke`, {});
                this.syncInviteSelected.delete(String(id));
                await this.renderSyncInvites();
                this.showToast('邀请码已撤销');
            } catch (error) {
                this.showToast('撤销失败：' + error.message, 'error');
            }
        }

        // ---- 管理员：同步管理的空间治理 ----
        //
        // 三条纪律，与邀请码那一块同款：
        //   ① **只显示非敏感项**（标识、状态、体积、版本、代次、活跃设备数、时间）。
        //      服务端就不回正文与凭据（见 `listSpaces`），所以这里也没有可泄露的东西
        //      ——界面上不显示某样东西，不构成权限边界，边界在服务端。
        //   ② **`syncSpacesRendered` 闩锁**：面板每次
        //      重建 DOM，#syncSpacesList 是一个新的「加载中…」节点，而配置缓存还在
        //      内存里。拿「数据在不在内存」当判据的话，展开/重渲染时条件为假、
        //      不发请求，占位符永远留在页面上。
        //   ③ **重渲染只重画，不重复拉接口**：每次配置保存引起的重渲染都会再打一次
        //      管理接口，攒进同一个限流桶（邀请码那块踩过，这里有断言钉着）。

        /** 空间列表的查询串：只带非默认值，「全部状态 / 最近更新 / 第 1 页」的 URL 最短。 */
        syncSpacesQuery() {
            const filter = this.syncSpacesFilter || { q: '', state: 'all', sort: 'updated', offset: 0, limit: SYNC_PAGE_SIZE };
            const params = [];
            if (filter.q) params.push(`q=${encodeURIComponent(filter.q)}`);
            if (filter.state && filter.state !== 'all') params.push(`state=${encodeURIComponent(filter.state)}`);
            if (filter.sort && filter.sort !== 'updated') params.push(`sort=${encodeURIComponent(filter.sort)}`);
            if (filter.offset > 0) params.push(`offset=${filter.offset}`);
            params.push(`limit=${filter.limit || SYNC_PAGE_SIZE}`);
            return `?${params.join('&')}`;
        }

        async renderSyncSpaces() {
            const list = $('#syncSpacesList');
            if (!list) return;
            try {
                // 列表、策略、用量都在**同一个响应**里（服务端一次查全）：面板每打开一次
                // 就会重画这三块，分成几条 GET 等于每次打开多打几条管理接口，而管理桶
                // 只有 30 次/分钟——本仓库已经因为「渲染里顺手预取」撞过 429。
                const url = '/api/admin/sync-spaces' + this.syncSpacesQuery();
                const data = await API.get(url);
                this.syncSpaces = data.spaces || [];
                this.syncSpacesPage = data.page || { total: this.syncSpaces.length, offset: 0, limit: SYNC_PAGE_SIZE };
                this.syncUsage = data.usage || { spaces: 0, bytes: 0, devices: 0 };
                this.syncPolicy = data.settings || { creatingPaused: false, syncPaused: false, inviteRequired: true };
                this.syncSpacesRendered = true;
                // 页码越界（删掉/筛掉最后一页的唯一一行之后）回退一页再拉一次。
                // 只重试一次：再错就是服务端的事，不能在这里转圈。
                const page = this.syncSpacesPage;
                if (!this.syncSpacesClamping && page.total > 0 && page.offset >= page.total) {
                    const perPage = page.limit || SYNC_PAGE_SIZE;
                    this.syncSpacesFilter.offset = Math.max(0, (Math.ceil(page.total / perPage) - 1) * perPage);
                    this.syncSpacesClamping = true;
                    try { await this.renderSyncSpaces(); } finally { this.syncSpacesClamping = false; }
                    return;
                }
                // 勾选集只保留本页还在的行：翻页/筛选后残留的 id 会让「批量停用」
                // 对着看不见的行下手。
                const visible = new Set(this.syncSpaces.map(space => String(space.id)));
                for (const id of [...this.syncSpacesSelected]) if (!visible.has(id)) this.syncSpacesSelected.delete(id);
                // ⚠️ 开关必须**在这之后**重画：面板渲染那一刻 `renderSyncSpaces()` 还在
                // 飞，`syncPolicy` 还是空的，`paintSyncPolicy()` 会直接返回——只画列表
                // 不画开关，症状是「上次开过总暂停，这次打开面板却看着是关的」。
                this.paintSyncPolicy();
                this.paintSyncOverview();
                this.paintSyncSpaces();
            } catch (error) {
                this.syncSpacesRendered = false;
                list.innerHTML = `<p class="fav-hint">同步空间读取失败：${this.esc(error.message)}</p>
                    <button type="button" class="btn btn-sm" data-action="retry-spaces">重试</button>`;
            }
        }

        /** 体积按 KiB/MiB 说——管理员关心的是「谁占了大头」，不是精确到字节。 */
        syncBytes(bytes) {
            const value = Number(bytes) || 0;
            if (value < 1024) return `${value} B`;
            if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
            return `${(value / (1024 * 1024)).toFixed(2)} MiB`;
        }

        /** 概览四块：用户数 / 全实例存储占用 / 活跃设备数 / 同步服务状态。 */
        paintSyncOverview() {
            const host = $('#syncOverview');
            if (!host) return;
            const usage = this.syncUsage || { spaces: 0, bytes: 0, devices: 0 };
            const policy = this.syncPolicy || { creatingPaused: false, syncPaused: false, inviteRequired: true };
            // 三种状态分开说：只暂停新建与总暂停看起来都是「没在新建」。
            const status = policy.syncPaused ? '已暂停' : policy.creatingPaused ? '暂停新建' : '正常';
            host.innerHTML = `
                <div class="sync-stat"><b>${Number(usage.spaces) || 0}</b><span>用户数（上限 1000）</span></div>
                <div class="sync-stat"><b>${this.syncBytes(usage.bytes)}</b><span>全实例存储占用</span></div>
                <div class="sync-stat"><b>${Number(usage.devices) || 0}</b><span>活跃设备数</span></div>
                <div class="sync-stat"><b>${this.esc(status)}</b><span>同步服务状态</span></div>`;
        }

        /** 只重画空间列表（表格 + 勾选 + 计数行 + 翻页），**不发请求**。 */
        paintSyncSpaces() {
            const list = $('#syncSpacesList');
            if (!list) return;
            const spaces = this.syncSpaces || [];
            const page = this.syncSpacesPage || { total: spaces.length, offset: 0, limit: SYNC_PAGE_SIZE };
            const filter = this.syncSpacesFilter || {};
            const perPage = page.limit || SYNC_PAGE_SIZE;
            const from = page.total === 0 ? 0 : page.offset + 1;
            const to = Math.min(page.offset + spaces.length, page.total);
            const selected = this.syncSpacesSelected;
            if (!spaces.length) {
                // 空态分两种：搜出来是空的，与一个空间都还没有——后者要告诉用户下一步。
                const empty = filter.q
                    ? `没有匹配「${this.esc(filter.q)}」的空间`
                    : '还没有任何用户空间。管理员发放邀请码后，访客创建的空间会出现在这里。';
                list.innerHTML = `<div class="sync-empty">${empty}</div>`;
            } else {
                const label = space => String(space.id).slice(0, 8);
                list.innerHTML = `<table class="sync-table">
                    <thead><tr>
                        <th><input type="checkbox" id="syncSpacesSelectAll" aria-label="全选本页"></th>
                        <th>备注 / 标识</th><th>状态</th><th>体积</th><th>版本</th><th>代次</th><th>设备</th><th>创建</th><th>最近更新</th><th>操作</th>
                    </tr></thead>
                    <tbody>${spaces.map(space => {
                        const id = String(space.id);
                        const state = space.deleted ? '已删除'
                            : space.disabled ? '已停用'
                                : '正常';
                        const mark = space.deleted ? 'is-gone' : space.disabled ? 'is-stale' : '';
                        // 已删除的墓碑只留作记录（还能看出它曾经存在），不再给操作按钮。
                        const actions = space.deleted ? ''
                            : `<button type="button" class="btn btn-sm" data-action="edit-note" data-id="${this.esc(id)}">备注</button>
                               <button type="button" class="btn btn-sm" data-action="toggle-space" data-id="${this.esc(id)}" data-disabled="${space.disabled ? '0' : '1'}">${space.disabled ? '重新启用' : '停用'}</button>
                               <button type="button" class="btn btn-sm" data-action="reset-devices" data-id="${this.esc(id)}">重置设备</button>
                               <button type="button" class="btn btn-sm btn-danger" data-action="delete-space" data-id="${this.esc(id)}">删除</button>`;
                        return `<tr class="sync-space-row ${mark}">
                            <td><input type="checkbox" data-select-space="${this.esc(id)}" aria-label="选择空间 ${this.esc(label(space))}" ${space.deleted ? 'disabled' : ''} ${selected.has(id) ? 'checked' : ''}></td>
                            <td>${this.esc(space.note || "未备注")}<br><code>${this.esc(label(space))}</code></td>
                            <td><span class="sync-space-state">${state}</span></td>
                            <td class="num">${space.contentBytes ? this.syncBytes(space.contentBytes) : '—'}</td>
                            <td class="num">${space.revision}</td>
                            <td class="num">${space.generation}</td>
                            <td class="num">${space.activeDevices}</td>
                            <td>${this.esc(this.syncRelTime(space.createdAt))}</td>
                            <td><span class="sync-space-time">${this.esc(this.syncRelTime(space.updatedAt))}</span></td>
                            <td>${actions}</td>
                        </tr>`;
                    }).join('')}</tbody>
                </table>`;
            }
            // 计数行一直说「第 X–Y 条，共 N 条」；上一页/下一页只在真的分页时才出现
            // （只有几个空间时那一行是噪音）。
            const summary = $('#syncSpacesSummary');
            if (summary) summary.textContent = page.total ? `第 ${from}–${to} 条，共 ${page.total} 条` : '共 0 条';
            // 窄屏（折叠屏外屏 / 手机）里表格会在容器内横向滚动，提示只在真溢出时出现。
            const host = $('#syncSpacesList');
            if (host) host.classList.toggle('is-scrollable', host.scrollWidth > host.clientWidth + 1);
            const pager = $('#syncSpacesPager');
            if (pager) {
                const pages = Math.max(1, Math.ceil(page.total / perPage));
                pager.hidden = page.total <= perPage;
                pager.innerHTML = `<button type="button" class="btn btn-sm" data-action="spaces-prev" ${page.offset <= 0 ? 'disabled' : ''}>上一页</button>
                    <span class="sync-pager-page">第 ${Math.floor(page.offset / perPage) + 1} / ${pages} 页</span>
                    <button type="button" class="btn btn-sm" data-action="spaces-next" ${to >= page.total ? 'disabled' : ''}>下一页</button>`;
            }
            this.paintSyncSpacesBulk();
        }

        /** 批量停用的按钮态与「全选本页」的勾选态（不发请求）。 */
        paintSyncSpacesBulk() {
            const button = $('#disableSelectedSpaces');
            const count = this.syncSpacesSelected.size;
            if (button) {
                button.disabled = count === 0;
                button.textContent = count ? `批量停用（${count}）` : '批量停用';
            }
            const all = $('#syncSpacesSelectAll');
            if (all) {
                const selectable = (this.syncSpaces || []).filter(space => !space.deleted);
                all.checked = selectable.length > 0 && selectable.every(space => this.syncSpacesSelected.has(String(space.id)));
            }
            const hint = $('#syncSpacesSelection');
            if (hint) hint.textContent = count ? `已选 ${count} 个` : '';
        }

        toggleSyncSpaceSelection(id, checked) {
            const key = String(id || '');
            if (!key) return;
            if (checked) this.syncSpacesSelected.add(key); else this.syncSpacesSelected.delete(key);
            this.paintSyncSpacesBulk();
        }

        /** 「全选本页」：只勾得上本页里**没被删除**的那些（墓碑没有可批量做的动作）。 */
        toggleAllSyncSpaces(checked) {
            this.syncSpacesSelected.clear();
            if (checked) {
                for (const space of this.syncSpaces || []) {
                    if (!space.deleted) this.syncSpacesSelected.add(String(space.id));
                }
            }
            this.paintSyncSpaces();
        }

        /**
         * 批量停用。
         *
         * 服务端只有**单条**停用接口（没有批量端点），所以这里逐个 POST。刻意逐条：
         * 一条失败不该让其余几条静默作罢——每一条各自报错、各自计数，最后说清成功了几个。
         * **不提供批量删除**：删除不可撤销，逐个确认是这一组的底线。
         */
        async disableSelectedSyncSpaces() {
            const ids = [...this.syncSpacesSelected];
            if (!ids.length) return;
            if (!await this.confirmAction(`停用选中的 ${ids.length} 个空间？它们上面的设备会立刻进入停用态，随时可以重新启用。`, '批量停用')) return;
            const button = $('#disableSelectedSpaces');
            if (button) button.disabled = true;
            let done = 0;
            for (const id of ids) {
                try {
                    await API.post(`/api/admin/sync-spaces/${encodeURIComponent(id)}/disable`, { disabled: true });
                    done++;
                } catch (error) {
                    this.showToast('停用失败：' + error.message, 'error');
                }
            }
            this.syncSpacesSelected.clear();
            await this.renderSyncSpaces();
            if (done) this.showToast(`已停用 ${done} 个空间`);
        }

        /** 总开关的勾选态与说明行。**三个开关各自独立**（邀请码只管创建，暂停新建只挡新空间）。 */
        paintSyncPolicy() {
            const policy = this.syncPolicy;
            if (!policy) return;
            const invite = $('#syncInviteRequired');
            const creating = $('#syncCreatingPaused');
            const total = $('#syncTotalPaused');
            if (invite) invite.checked = policy.inviteRequired !== false;
            if (creating) creating.checked = !!policy.creatingPaused;
            if (total) total.checked = !!policy.syncPaused;
            const inviteHint = $('#syncInviteHint');
            if (inviteHint) {
                inviteHint.textContent = policy.inviteRequired === false
                    ? '邀请功能已关闭，访客只凭口令即可创建空间；已生成的邀请码保留，重新开启后生效。'
                    : '邀请码一次性使用，有效期 48 小时。';
            }
            const hint = $('#syncPolicyHint');
            if (!hint) return;
            // 三种状态的说明必须分开说：只暂停新建与总暂停看起来都是「没在新建」。
            hint.textContent = policy.syncPaused
                ? '总暂停已开启：所有空间的读写与连接都被拒绝（删除空间与撤销本机设备不受影响）。'
                : policy.creatingPaused
                    ? '已暂停新建：不能再创建新空间，已有空间照常同步。'
                    : policy.inviteRequired === false
                        ? '邀请功能已关闭：访客输入口令即可创建同步空间，无需邀请码。'
                        : '';
            // 总暂停是「整台服务的读写都停了」，比「暂停新建」重一档：说这句话的那一行
            // 要显眼（照样例的红字），否则它读起来像一条普通提示。
            hint.classList.toggle('is-warn', !!policy.syncPaused);
        }

        /**
         * 保存总开关。
         *
         * ⚠️ 三个勾选框的值一起提交，但各自的语义独立
         * （服务端按 `!== undefined` 判，所以传 `false` 是真的会打开）。
         * 失败要把勾选态**回滚成服务端的确认值**，不能留着一个「看着已勾上、
         * 实际没生效」的界面。
         */
        async saveSyncPolicy() {
            const invite = $('#syncInviteRequired');
            const creating = $('#syncCreatingPaused');
            const total = $('#syncTotalPaused');
            const body = {
                inviteRequired: !!(invite && invite.checked),
                creatingPaused: !!(creating && creating.checked),
                syncPaused: !!(total && total.checked)
            };
            [invite, creating, total].forEach(box => { if (box) box.disabled = true; });
            try {
                const result = await API.post('/api/admin/sync-settings', body);
                this.syncPolicy = result.settings;
                this.paintSyncPolicy();
                this.paintSyncOverview();   // 概览里的「同步服务状态」跟着变
                this.showToast('同步策略已保存');
            } catch (error) {
                this.paintSyncPolicy();   // 回滚成内存里的（服务端确认过的）值
                this.showToast('保存失败：' + error.message, 'error');
            } finally {
                [invite, creating, total].forEach(box => { if (box) box.disabled = false; });
            }
        }

        async toggleSyncSpace(id, disabled) {
            try {
                await API.post(`/api/admin/sync-spaces/${encodeURIComponent(id)}/disable`, { disabled });
                await this.renderSyncSpaces();
                this.showToast(disabled ? '已停用该空间' : '已重新启用该空间');
            } catch (error) {
                this.showToast('操作失败：' + error.message, 'error');
            }
        }

        async deleteSyncSpace(id) {
            // 删除**不可撤销**（墓碑只是留痕，内容已经清掉），所以先确认一次。
            // ⚠️ 用仓库自己的 `confirmAction`（危险样式、与删除收藏/引擎同一个对话框），
            // 不要用原生 `window.confirm`：它会阻塞脚本线程、样式与本项目不一致，
            // 而且自动化里默认被丢掉（等于这个按钮永远点不成）。
            if (!await this.confirmAction('删除这个云端空间？它上面的所有设备会立刻失效，内容会被清空，此操作无法撤销。', '删除云端空间', true)) return;
            try {
                await API.post(`/api/admin/sync-spaces/${encodeURIComponent(id)}/delete`, {});
                await this.renderSyncSpaces();
                this.showToast('空间已删除');
            } catch (error) {
                this.showToast('删除失败：' + error.message, 'error');
            }
        }

        async editSyncSpaceNote(id) {
            const space = (this.syncSpaces || []).find(item => String(item.id) === String(id));
            const value = await this.promptValue('编辑用户备注', '备注', {
                value: space?.note || '',
                placeholder: '最多 100 个字符',
                validate: values => values[0].trim().length > 100 ? '备注不能超过 100 个字符' : ''
            });
            if (value === null) return;
            try {
                await API.post(`/api/admin/sync-spaces/${encodeURIComponent(id)}/note`, { note: value.trim() });
                await this.renderSyncSpaces();
                this.showToast('备注已保存');
            } catch (error) {
                this.showToast('保存备注失败：' + error.message, 'error');
            }
        }

        async resetSyncSpaceDevices(id) {
            if (!await this.confirmAction('重置这个空间的所有设备？设备会立刻失效，用户需要重新输入口令连接。空间内容和版本不会改变。', '重置设备', true)) return;
            try {
                const result = await API.post(`/api/admin/sync-spaces/${encodeURIComponent(id)}/reset-devices`, {});
                await this.renderSyncSpaces();
                this.showToast(result.revoked ? `已撤销 ${result.revoked} 台设备` : '没有需要撤销的设备');
            } catch (error) {
                this.showToast('重置设备失败：' + error.message, 'error');
            }
        }

        /** 读本机连接记录；有连接就立刻检查一次，并把盘上的待上传内容重放出去。 */
        async loadSyncState() {
            // 设计 §4.1：确认身份前不启动普通同步。探测失败时 `identityPending`
            // 保持为真（= 同步暂停），直到 checkAdministratorSync 成功确认身份。
            await this.waitForSession();
            if (!this.localStore) return;
            this.bindSyncChannel();
            let record;
            try { record = await this.localStore.readSync(); }
            catch (error) { this.setSyncState('error', '未能读取本机同步状态：' + error.message); return; }
            this.syncRecordRevision = record?.revision || 0;
            this.syncConnEpoch = record?.connEpoch || 0;
            this.syncConnection = record?.connection || null;
            this.syncRecovery = record?.recovery || null;
            this.syncPending = record?.pending || null;
            this.syncClaim = record?.claim || null;
            this.syncLastSuccessAt = record?.lastSuccessAt || null;
            this.syncUploadedPayloadKey = record?.uploadedPayloadKey ?? null;
            this.markSyncEntry();
            if (!this.syncConnection) { this.setSyncStatus('local'); this.setSyncState('disconnected'); return; }
            this.setSyncState('connected');
            this.setSyncStatus(this.syncPending ? 'pending' : 'synced');
            // 打开即检查一次（设计 §5 的四个触发点之一），并起 30 秒轮询。
            await this.syncPullCheck();
            this.startSyncPolling();
            // 两种情况都要在这里接着同步（设计 §5「页面关闭前已保存本地的修改，
            // 下次打开继续同步」）：
            //   · 盘上有待上传内容 → 立刻重放（同一个 operationId，不重复写入）；
            //   · 本地修订还没有被确认上传过 → 上一次是在防抖窗口里关掉的页面、
            //     或者当时离线，那次改动只落在本机。**漏掉这一条，那次改动就
            //     永远传不上去**：重启后没有任何东西会再排一次上传。
            if (this.syncPending) this.startSyncUpload();
            else if (this.syncUploadedPayloadKey !== this.syncPayloadKey()) this.scheduleSyncUpload();
        }

        setSyncState(state, message = '') {
            this.syncState = state;
            this.syncError = message;
            if (state !== 'connected') this.syncCloud = state === 'error' ? this.syncCloud : null;
            this.markSyncEntry();
            this.renderSyncDialog();
        }

        /** 页脚入口的文案/状态由这一处决定，别在别处再写一遍。 */
        markSyncEntry() {
            const button = $('#syncBtn');
            if (!button) return;
            const status = this.syncConnection ? this.syncStatus : 'local';
            button.textContent = SYNC_STATUS_LABEL[status] || '同步';
            button.dataset.state = status;
            button.title = status === 'local' ? '用口令连接云端空间' : `云端空间：${SYNC_STATUS_TEXT[status] || ''}`;
        }

        /**
         * 本地断开——**唯一的**断开路径：停止同步、删除空间、服务端判为终态都走它。
         *
         * ⚠️ 三件事必须在**同一个** IndexedDB 写事务里完成：
         *   ① 连接代次 +1；② 清掉凭据与待上传任务；③ 清掉跨标签页的 claim。
         * 分开写就会出现「代次变了但凭据还在」的中间态，而那个窗口里一个在飞的
         * 连接请求完全可以把凭据写回来（验收：「迟到响应及排队写入不能恢复凭据」）。
         * 本地导航与「替换前的副本」**不动**——停止只断开同步，不碰用户的导航。
         */
        async clearSyncConnection(message) {
            const token = this.syncConnection?.deviceToken || null;
            this.syncConnection = null;
            this.syncProof = null;
            this.syncSpaceInfo = null;
            this.syncCloud = null;
            this.syncPending = null;
            this.syncClaim = null;
            this.syncConflict = null;
            this.syncBackoffMs = 0;
            this.syncUploadInFlight = false;
            this.syncUploadedPayloadKey = null;
            this.syncUploadAgain = false;
            this.syncHalted = null;
            this.setSyncStatus('local');
            this.stopSyncTimers();
            this.setSyncState(message ? 'error' : 'disconnected', message);
            try {
                await this.writeSyncWithEpochRetry({ connection: null, pending: null, claim: null, uploadedPayloadKey: null }, { bumpEpoch: true });
            } catch (error) {
                // 落盘失败必须**在这里**收口：调用点有 4 处（停止、删除、终态、上传/拉取内部），
                // 漏掉的 promise 会变成未处理的 rejection，而界面已经显示「未连接」了。
                // 说白了：内存已断开、记录里的凭据还在，刷新会「又连上」——告诉用户，
                // 让他再点一次，而不是假装断开成功。
                this.setSyncState('error', '本机断开未保存：' + error.message + '（刷新后可能仍显示已连接，请再试一次）');
                return token;
            }
            // 通知其它标签页取消调度（设计：「随后通知全部标签页取消调度」）。
            // 正确性不靠它：上面那次事务提交才算断开完成。
            this.notifySyncPeers('stopped');
            return token;
        }

        /**
         * 带一次重读重试的落盘。两种失败都值得重试一次：
         *   · `epoch`——别的标签页刚断开/重连（停止是幂等的，重读后再写）；
         *   · `conflict`——别的标签页刚写了记录（修订号推进了一格）。
         * 重试仍失败就**报错退出，绝不硬写**：硬写等于把别人的状态覆盖掉。
         */
        async writeSyncWithEpochRetry(patch, options = {}) {
            for (let attempt = 0; attempt < 2; attempt++) {
                // ⚠️ 代次要在**循环内**重算：`patch` 里的 `+1` 只在调用处求值一次，
                // 而重试前刚做过一次重读，记录里的代次可能已经比它高——拿旧值写回去
                // 会让「只增不减」的代次回退，之后内存代次更高的标签页每次落盘都被拒。
                const body = options.bumpEpoch ? { ...patch, connEpoch: (this.syncConnEpoch || 0) + 1 } : patch;
                try {
                    const record = await this.persistSyncRecord(body);
                    return record;
                } catch (error) {
                    if (error.code !== 'epoch' && error.code !== 'conflict') {
                        this.setSyncState('error', '未能保存到本机：' + error.message);
                        throw error;
                    }
                    await this.refreshSyncRecord();
                }
            }
            this.setSyncState('error', '本机同步状态被其它标签页改动，未能保存');
            throw Object.assign(new Error('本机同步状态被其它标签页改动'), { code: 'conflict' });
        }

        /** 重新读一遍本机记录并同步到内存（别的标签页改了状态后用）。 */
        async refreshSyncRecord() {
            let record = null;
            try { record = await this.localStore.readSync(); }
            catch (error) { this.setSyncState('error', '未能读取本机同步状态：' + error.message); return null; }
            this.syncRecordRevision = record?.revision || 0;
            this.syncConnEpoch = record?.connEpoch || 0;
            const had = !!this.syncConnection;
            this.syncConnection = record?.connection || null;
            this.syncRecovery = record?.recovery || null;
            this.syncPending = record?.pending || null;
            this.syncClaim = record?.claim || null;
            this.syncLastSuccessAt = record?.lastSuccessAt || null;
            this.syncUploadedPayloadKey = record?.uploadedPayloadKey ?? null;
            if (!this.syncConnection) {
                this.stopSyncTimers();
                this.setSyncStatus('local');
                if (had) this.setSyncState('disconnected');
            }
            return record;
        }

        /**
         * 停止同步（用户主动）。
         *
         * 顺序是刻意的：**先本地断开、再尽力撤销服务端令牌**。离线时撤销失败不影响
         * 断开——设计明确要求「离线断开允许完成，在线尽力撤销令牌」，所以这里不
         * await 那个请求，也不把它做成用户可见的错误。
         */
        async stopSyncLocal() {
            const token = await this.clearSyncConnection();
            if (token && navigator.onLine !== false) {
                API.post('/api/sync/device/revoke', {}, { token }).catch(() => {});
            }
            this.setSyncStatus('local');
            this.markSyncEntry();
            this.renderSyncDialog();
            return token;
        }

        /**
         * 把连接写进本机，**成功之后**才置「已连接」。
         * 失败一律停在 error 态并把原因说出来——这是验收里
         * 「凭据保存失败不显示连接成功」那一条的落点。
         */
        async persistSyncConnection(snapshot) {
            const record = await this.persistSyncRecord(snapshot);
            return record;
        }

        /**
         * 打开同步对话框。
         *
         * ⚠️ 界面**必须临开临建、关掉就删**，不能像页脚按钮那样常驻一个 hidden 节点。
         * `.ui-dialog-overlay` 在本文件里是「现在有没有对话框开着」的判据（阻止关闭
         * 页面、启动流程等都用它查），放一个隐藏的常驻节点进去会让那些判据**恒真**。
         * 这正是 `showUiDialog` 自己也临建临删的原因。
         */
        async openSyncDialog() {
            if (this.syncDialogEl) return;
            const overlay = html(`
                <div class="ui-dialog-overlay" id="syncDialog" data-action="close">
                    <div class="ui-dialog sync-dialog" role="dialog" aria-modal="true" aria-labelledby="syncDialogTitle">
                        <button type="button" class="sync-dialog-close" id="syncClose" aria-label="关闭" data-action="close">
                            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
                        </button>
                        <h3 id="syncDialogTitle">云端空间</h3>
                        <div class="sync-dialog-body" id="syncDialogBody"></div>
                    </div>
                </div>
            `);
            document.body.appendChild(overlay);
            this.syncDialogEl = overlay;
            this.syncProof = null;
            this.syncSpaceInfo = null;
            this.syncError = '';
            this.syncState = this.syncConnection ? 'connected' : 'disconnected';
            overlay.addEventListener('click', event => {
                // 只认「点在遮罩或关闭叉上」：内部控件的事件会冒泡到这里，
                // 但那时 event.target 是控件自己。
                if (event.target === overlay || event.target.closest('.sync-dialog-close')) return this.closeSyncDialog();
                const id = event.target.id;
                if (id === 'syncBack') { this.syncProof = null; this.syncBusy = false; return this.setSyncState(this.syncConnection ? 'connected' : 'disconnected'); }
                // 停止同步：先问一句再断（本地断开不可逆的是「要重新输口令」这一步，
                // 云端与其他设备不受影响，所以文案要说清这两点）。
                if (id === 'syncRetry') return this.retrySyncAfterHalt();
                if (id === 'syncStop') return this.setSyncState('confirm_stop');
                if (id === 'syncStopBack') return this.setSyncState('connected');
                if (id === 'syncStopConfirm') return this.confirmStopSync();
                // 撤销全部旧设备并重新连接：也是危险操作（会踢掉其他设备），
                // 但从**次级链接**进入，且确认态要求重新输入口令。
                if (id === 'syncResetDevices') return this.requestResetDevices();
                if (id === 'syncResetBack') return this.setSyncState(this.syncConnection ? 'connected' : 'exists');
                if (id === 'syncResetConfirm') return this.confirmResetDevices();
                if (id === 'syncCheck') return this.submitSyncPassphrase();
                if (id === 'syncCreate') return this.createSyncSpace();
                if (id === 'syncPull') return this.connectSyncSpace('cloud');
                if (id === 'syncPush') return this.connectSyncSpace('local');
                if (id === 'syncRecoveryExport') return this.exportSyncRecovery();
                // 立即同步：先看云端有没有新内容，再把本地待上传的排出去。
                // 手动同步必须有自己的忙碌态：云端没有变化时状态不变，
                // 若只靠 setSyncStatus 重绘，点下去会毫无反馈。
                if (id === 'syncNow') return this.runManualSync();
                if (id === 'syncConflictExport') return this.exportSyncConflict();
                if (id === 'syncConflictCloud') return this.resolveSyncConflict('cloud');
                if (id === 'syncConflictLocal') return this.resolveSyncConflict('local');
            });
            overlay.addEventListener('keydown', event => {
                if (event.key === 'Escape') { event.preventDefault(); return this.closeSyncDialog(); }
                // 口令框里按回车 = 点「检查并连接」；撤销设备的确认框里回车 = 确认撤销。
                if (event.key === 'Enter' && event.target.tagName === 'INPUT') {
                    event.preventDefault();
                    if (event.target.id === 'syncResetPassphrase') return this.confirmResetDevices();
                    this.submitSyncPassphrase();
                }
            });
            this.renderSyncDialog();
            const first = overlay.querySelector('#syncDialogBody input, #syncDialogBody button');
            if (first) first.focus();
        }

        closeSyncDialog() {
            if (this.syncDialogEl) { this.syncDialogEl.remove(); this.syncDialogEl = null; }
            // 口令与证明只服务于这次流程，关掉即弃。
            this.syncProof = null;
            this.syncSpaceInfo = null;
        }

        /** 手动同步：忙碌态由按钮自己承担，云端无变化时也能看见反馈。 */
        async runManualSync() {
            if (this.syncBusy || !this.syncConnection) return;
            this.syncBusy = true;
            this.setSyncState('connected');
            try {
                await this.syncPullCheck();
                if (this.syncPending) this.scheduleSyncUpload();
            } finally {
                this.syncBusy = false;
                // 同步过程中可能被服务端判成暂停/停用，此时也必须重绘，
                // 否则「重试同步」会一直停在忙碌态的禁用状态。
                if (this.syncDialogEl) this.renderSyncDialog();
            }
        }

        renderSyncDialog() {
            const dialog = this.syncDialogEl;
            const body = dialog && dialog.querySelector('#syncDialogBody');
            if (!body) return;
            const recovery = this.syncRecovery
                ? `<p class="sync-note">已保留替换前的副本（${this.esc(this.syncRecovery.direction === 'cloud' ? '云端' : '本机')}，${this.esc(this.syncRelTime(this.syncRecovery.savedAt))}） <button type="button" class="sync-link" id="syncRecoveryExport">导出</button></p>`
                : '';
            if (this.syncState === 'connected' && this.syncStatus === 'conflict' && this.syncConflict) {
                // 冲突态：两个候选都还在，选之前可以先导出。
                const conflict = this.syncConflict;
                body.innerHTML = `
                    <p class="sync-state">${this.esc(SYNC_STATUS_TEXT.conflict)}</p>
                    <p class="sync-note">本机与云端不一致 · 最近更新 ${this.esc(conflict.updatedAt ? this.syncRelTime(conflict.updatedAt) : '—')} · 本机有一份未上传的修改</p>
                    <p class="sync-hint">两份都完整保留，选择其中一份覆盖另一份。选之前可以先导出。</p>
                    ${this.syncError ? `<p class="sync-error" role="alert">${this.esc(this.syncError)}</p>` : ''}
                    <div class="ui-dialog-actions sync-actions">
                        <button type="button" class="btn" id="syncConflictExport">导出两边</button>
                        <button type="button" class="btn" id="syncConflictCloud">采用云端（覆盖本机）</button>
                        <button type="button" class="btn btn-primary" id="syncConflictLocal">保留本机（覆盖云端）</button>
                    </div>`;
                return;
            }
            if (this.syncState === 'connected') {
                const space = this.syncConnection || {};
                const cloud = this.syncCloud || {};
                body.innerHTML = `
                    <p class="sync-state">${this.esc(SYNC_STATUS_TEXT[this.syncConnection ? this.syncStatus : 'local'] || '已连接')}</p>
                    <p class="sync-note">云端空间 <code>${this.esc(String(space.spaceId || '').slice(0, 8))}</code> · 最近更新 ${this.esc(cloud.updatedAt ? this.syncRelTime(cloud.updatedAt) : '—')}</p>
                    ${recovery}
                    ${this.syncError ? `<p class="sync-error" role="alert">${this.esc(this.syncError)}</p>` : ''}
                    <p class="sync-hint">其他设备用同一口令连接，本机修改自动同步。</p>
                    <div class="ui-dialog-actions sync-actions">
                        <button type="button" class="btn" id="syncStop" ${this.syncBusy ? 'disabled' : ''}>停止同步</button>
                        <button type="button" class="btn" id="syncNow" ${this.syncBusy ? 'disabled' : ''} aria-busy="${this.syncBusy ? 'true' : 'false'}">${this.syncBusy ? '<span class="sync-spinner" aria-hidden="true"></span>同步中…' : '立即同步'}</button>
                    </div>
                    <p class="sync-note sync-danger-zone"><button type="button" class="sync-link" id="syncResetDevices">撤销全部旧设备并重新连接</button><br>其他设备会立刻停止同步，需要重新输入口令才能再连；本机导航与云端内容都不动。</p>`;
                return;
            }
            if (this.syncState === 'halted' && this.syncConnection) {
                // 两种暂停共用这一屏，但**文案不同**——各自说清「为什么会停、你现在能做什么」。
                // 总暂停是整台服务停了（等一会儿自动恢复，也可以手动重试）；
                // 空间停用只影响这一个空间（等管理员重新启用它）。
                const paused = this.syncHalted === 'paused';
                body.innerHTML = `
                    <p class="sync-state">${paused ? '同步服务已被暂停' : '空间已被停用'}</p>
                    <p class="sync-note">${paused
                        ? '管理员暂停了同步服务，恢复后会自动继续。'
                        : `云端空间 <code>${this.esc(String(this.syncConnection.spaceId || '').slice(0, 8))}</code> 已被管理员停用。`}</p>
                    <p class="sync-hint">本机导航不受影响。${paused
                        ? '管理员恢复后无需操作，也可以现在就重试。'
                        : '管理员重新启用后点「重试同步」即可继续。'}</p>
                    ${this.syncError ? `<p class="sync-error" role="alert">${this.esc(this.syncError)}</p>` : ''}
                    <div class="ui-dialog-actions sync-actions">
                        <button type="button" class="btn" id="syncStop">停止同步</button>
                        <button type="button" class="btn btn-primary" id="syncRetry" ${this.syncBusy ? 'disabled' : ''}>重试同步</button>
                    </div>`;
                return;
            }
            if (this.syncState === 'confirm_stop') {
                body.innerHTML = `
                    <p class="sync-state">停止同步？</p>
                    <p class="sync-note">本机导航会原样保留，只是不再与云端空间同步。云端空间与其他设备不受影响。</p>
                    <div class="ui-dialog-actions sync-actions">
                        <button type="button" class="btn" id="syncStopBack">返回</button>
                        <button type="button" class="btn btn-primary" id="syncStopConfirm" ${this.syncBusy ? 'disabled' : ''}>${this.syncBusy ? '停止中…' : '确认停止同步'}</button>
                    </div>`;
                return;
            }
            if (this.syncState === 'not_found') {
                // 邀请功能关闭时不画邀请码输入框：只凭口令即可创建。文案要说清这一步
                // 会上传本机配置，因为按钮一点就建空间。
                const needsInvite = this.syncInviteRequired !== false;
                body.innerHTML = `
                    <p class="sync-state">该口令还没有云端空间</p>
                    ${needsInvite
                        ? `<label class="ui-dialog-field"><span>邀请码</span><input id="syncInvite" type="text" autocomplete="off" spellcheck="false" placeholder="xxxx-xxxx-xxxx-xxxx-xxxx-xxxx"></label>
                    <p class="sync-hint">需要管理员发放的一次性邀请码。将把本机导航上传为新空间。</p>`
                        : `<p class="sync-hint">将把本机导航上传为云端空间，其他设备输入同一口令即可连接。</p>`}
                    ${this.syncError ? `<p class="sync-error" role="alert">${this.esc(this.syncError)}</p>` : ''}
                    <div class="ui-dialog-actions sync-actions">
                        <button type="button" class="btn" id="syncBack">返回</button>
                        <button type="button" class="btn btn-primary" id="syncCreate" ${this.syncBusy ? 'disabled' : ''}>${this.syncBusy ? '创建中…' : '用本机配置创建'}</button>
                    </div>`;
                return;
            }
            if (this.syncState === 'exists') {
                const info = this.syncSpaceInfo || {};
                body.innerHTML = `
                    <p class="sync-state">该口令已存在云端空间</p>
                    <p class="sync-note">最近更新 ${this.esc(info.updatedAt ? this.syncRelTime(info.updatedAt) : '—')} · ${this.esc(String(info.entryCount ?? 0))} 个条目</p>
                    <p class="sync-hint">两个方向都会先把被替换的那一份留在本机。</p>
                    ${this.syncError ? `<p class="sync-error" role="alert">${this.esc(this.syncError)}</p>` : ''}
                    <div class="ui-dialog-actions sync-actions">
                        <button type="button" class="btn" id="syncBack">返回</button>
                        <button type="button" class="btn" id="syncPull" ${this.syncBusy ? 'disabled' : ''}>使用云端配置</button>
                        <button type="button" class="btn btn-primary" id="syncPush" ${this.syncBusy ? 'disabled' : ''}>以本机配置替换云端</button>
                    </div>
                    <p class="sync-note sync-danger-zone"><button type="button" class="sync-link" id="syncResetDevices">撤销全部旧设备并重新连接</button><br>其他设备会立刻停止同步，需要重新输入口令才能再连；云端内容不动。</p>`;
                return;
            }
            if (this.syncState === 'confirm_reset') {
                // 撤销入口的确认态。**必须有自己的文案**：这里重新输入口令是**有用的**
                // （它定位空间、证明你是持有人），与「停止同步」「空间已停用」那两屏
                // 的告知正好相反——所以绝不能让这一屏落到别的确认态上。
                body.innerHTML = `
                    <p class="sync-state">撤销全部旧设备？</p>
                    <p class="sync-note">其他设备会立刻停止同步，需要重新输入口令才能再连。本机导航与云端内容都不动。</p>
                    <label class="ui-dialog-field"><span>重新输入口令</span><input id="syncResetPassphrase" type="password" autocomplete="current-password" spellcheck="false" placeholder="用于确认这是你的空间"></label>
                    ${this.syncError ? `<p class="sync-error" role="alert">${this.esc(this.syncError)}</p>` : ''}
                    <div class="ui-dialog-actions sync-actions">
                        <button type="button" class="btn" id="syncResetBack">返回</button>
                        <button type="button" class="btn btn-danger" id="syncResetConfirm" ${this.syncBusy ? 'disabled' : ''}>${this.syncBusy ? '撤销中…' : '确认撤销全部旧设备'}</button>
                    </div>`;
                return;
            }
            // disconnected / checking：口令与确认输入。
            const disabled = this.syncBusy ? 'disabled' : '';
            body.innerHTML = `
                <label class="ui-dialog-field"><span>口令</span><input id="syncPassphrase" type="password" autocomplete="new-password" spellcheck="false"></label>
                <label class="ui-dialog-field"><span>再输一次</span><input id="syncPassphraseConfirm" type="password" autocomplete="new-password" spellcheck="false"></label>
                    <p class="sync-hint">用一条口令在多台设备之间同步导航；不需要注册账号。</p>
                    <p class="sync-hint">知道口令的人都能读写这个空间，口令遗失无法找回。</p>
                ${this.syncError ? `<p class="sync-error" role="alert">${this.esc(this.syncError)}</p>` : ''}
                <div class="ui-dialog-actions sync-actions">
                    <button type="button" class="btn btn-primary" id="syncCheck" ${disabled}>${this.syncBusy ? '检查中…' : '检查并连接'}</button>
                </div>`;
        }

        /** 「检查并连接」：先本地校验，再问服务端这个口令有没有空间。 */
        async submitSyncPassphrase() {
            const passphrase = $('#syncPassphrase') ? $('#syncPassphrase').value : '';
            const confirm = $('#syncPassphraseConfirm') ? $('#syncPassphraseConfirm').value : '';
            const verdict = this.validateSyncPassphrase(passphrase);
            if (!verdict.ok) { this.setSyncState('disconnected', verdict.reason); return; }
            if (passphrase !== confirm) { this.setSyncState('disconnected', '两次输入的口令不一致'); return; }
            this.syncBusy = true;
            this.setSyncState('checking');
            try {
                const proof = await this.deriveSyncProof(passphrase);
                const result = await API.post('/api/sync/space/check', { proof });
                // 服务端随检查一起回邀请策略：旧服务端没有这个字段，按「需要邀请码」处理。
                this.syncInviteRequired = result.inviteRequired !== false;
                if (result.exists) {
                    this.syncProof = proof;
                    this.syncSpaceInfo = result;
                    this.syncBusy = false;
                    this.setSyncState('exists');
                } else {
                    this.syncProof = proof;
                    this.syncBusy = false;
                    this.setSyncState('not_found');
                }
            } catch (error) {
                this.syncBusy = false;
                this.setSyncState('disconnected', '检查失败：' + error.message);
            }
        }

        async createSyncSpace() {
            const inviteCode = $('#syncInvite') ? $('#syncInvite').value.trim() : '';
            // 只有开启邀请功能时才要求邀请码；关闭后服务端忽略这个字段，
            // 这里也就不把空串发上去。
            if (this.syncInviteRequired && !inviteCode) { this.setSyncState('not_found', '请输入邀请码'); return; }
            this.syncBusy = true;
            this.setSyncState('not_found');
            try {
                const body = {
                    proof: this.syncProof,
                    operationId: crypto.randomUUID(),
                    config: window.NavigationSchema.publicConfig(structuredClone(this.config)),
                    modules: this.localModulePayload()
                };
                if (inviteCode) body.inviteCode = inviteCode;
                const result = await API.post('/api/sync/space/create', body);
                await this.finishSyncConnection(result, 'local');
            } catch (error) {
                // 邀请码已被用掉 / 空间已被别人建出来：回到「已存在」让用户重新选。
                this.syncBusy = false;
                if (error.status === 409 || (error.status === 403 && /invite_used|space_exists/.test(error.code || ''))) {
                    const refreshed = await this.syncCheckQuiet();
                    if (refreshed && refreshed.exists) { this.syncSpaceInfo = refreshed; this.setSyncState('exists', '该口令已经建好空间了，请选择方向'); return; }
                }
                // ⚠️ 额度/暂停类 503（`space_limit`/`storage_limit`/`create_paused`）：
                // **不回查 `check`、不重发创建**。回查会让用户以为「空间也许建出来了」，
                // 而重发只会再撞同一个 503；设计明确禁止「借拒绝创建触发错误重建」。
                // 只把服务端那句话原样转述，用户知道是「等一会儿 / 找管理员」。
                if (error.status === 503) {
                    this.setSyncState('not_found', error.message);
                    return;
                }
                this.setSyncState('not_found', '创建失败：' + error.message);
            }
        }

        async syncCheckQuiet() {
            try { return await API.post('/api/sync/space/check', { proof: this.syncProof }); }
            catch { return null; }
        }

        /**
         * 连接既有空间。direction='cloud' 用云端配置覆盖本机，'local' 反过来。
         * 两个方向都先把**被替换的那份**写进 recovery，再动另一侧。
         */
        async connectSyncSpace(direction) {
            this.syncBusy = true;
            this.setSyncState('exists');
            try {
                const connection = await API.post('/api/sync/space/connect', { proof: this.syncProof, operationId: crypto.randomUUID() });
                const cloud = await API.get('/api/sync/config', { token: connection.deviceToken });
                await this.finishSyncConnection({ ...connection, cloud }, direction);
            } catch (error) {
                this.syncBusy = false;
                if (error.status === 409 || error.status === 404) {
                    const refreshed = await this.syncCheckQuiet();
                    if (refreshed) { this.syncSpaceInfo = refreshed; this.setSyncState(refreshed.exists ? 'exists' : 'not_found', '云端状态已变化，请重新选择'); return; }
                }
                this.setSyncState('exists', '连接失败：' + error.message);
            }
        }

        localModulePayload() {
            return { enabled: [], widgets: [], settings: {} };
        }

        /**
         * 收尾：先落盘，再采用内容，最后才说「已连接」。
         *
         * 顺序是有意的，三条都在验收里：
         *   · 落盘失败 → 不显示已连接（persistSyncConnection 抛错就到此为止）；
         *   · recovery 在改内容**之前**写，否则「替换前的副本」存的是替换后的；
         *   · 采用云端配置时先写本机 recovery 再覆盖 this.config。
         */
        async finishSyncConnection(material, direction) {
            // 只有**替换**才有「替换前的副本」。新建空间时云端本来就没有内容，
            // 那时写一份空的 recovery 只会在界面上写出一句没有意义的
            // 「已保留替换前的副本（云端）」——判据就取「这次动的是哪一侧」。
            const recovery = direction === 'cloud'
                ? { direction: 'local', savedAt: Date.now(), config: window.NavigationSchema.publicConfig(structuredClone(this.config)), modules: this.localModulePayload() }
                : material.cloud
                    ? { direction: 'cloud', savedAt: Date.now(), config: material.cloud.config, modules: material.cloud.modules || {} }
                    : null;
            const connection = {
                spaceId: material.spaceId,
                deviceToken: material.deviceToken,
                generation: material.generation,
                revision: material.revision,
                connectedAt: Date.now()
            };
            try {
                // ⚠️ 连接代次的递增必须和「写入连接」在**同一次**落盘里（与 clearSyncConnection
                // 同一个规矩）。只在内存里 +1 的话，记录里的代次还是旧值，而之后每一次
                // `persistSyncRecord` 都会拿「内存的新代次」去比「记录里的旧代次」——
                // 于是连接明明建好了，紧接着的上传/指纹落盘全被事务拒掉，
                // 症状是刚连上就显示「同步失败」（真实浏览器验收抓到过）。
                await this.persistSyncConnection({ connection, recovery, connEpoch: (this.syncConnEpoch || 0) + 1 });
            } catch (error) {
                this.syncBusy = false;
                this.syncConnection = null;
                // 代次不匹配 = 另一个标签页刚刚停止/删除/重连了：不能把这一份凭据写回去，
                // 也不能重试（重试就是在覆盖别人的状态），只能请用户重来一次。
                this.setSyncState('error', error.code === 'epoch'
                    ? '连接状态已被其它标签页改动，请重新打开同步'
                    : '未能保存到本机，连接未建立：' + error.message);
                return;
            }
            this.syncConnection = connection;
            let cloud = material.cloud || null;
            try {
                if (direction === 'local') {
                    const written = await this.writeCloudConfig(material.deviceToken, connection.revision);
                    connection.revision = written.revision;
                    await this.persistSyncConnection({ connection, recovery });
                    // 上传成功后云端就是刚写下的这一版：把版本号与时间补上，
                    // 否则状态行会一直显示上传**前**的版本（或一个空的「—」）。
                    cloud = { revision: written.revision, updatedAt: Date.now() };
                } else if (direction === 'reset') {
                    // 「撤销全部旧设备并重新连接」：只换了本机凭据，**两侧内容都没动**，
                    // 所以既不上传、也不采用——内容协调交给随后的那次拉取（不同就摆候选）。
                    // 这里若落进下面那个 else，会拿一个不存在的云端内容去采用。
                    cloud = { revision: connection.revision, updatedAt: Date.now() };
                } else {
                    await this.adoptCloudConfig(material.cloud);
                }
            } catch (error) {
                // 凭据已经落盘（连接算建立了），失败的是这一方向的内容替换。
                // 说清是哪一半没成，别笼统报「连接失败」——两者的下一步不一样。
                this.syncBusy = false;
                this.setSyncState('error', direction === 'local'
                    ? '已连接，但上传云端失败：' + error.message
                    : '已连接，但采用云端配置失败：' + error.message);
                return;
            }
            this.syncBusy = false;
            this.syncProof = null;
            this.syncCloud = cloud;
            this.setSyncState('connected');
            // 代次已经在上面那次事务里 +1 了（不要在这里再动内存：只动内存不落盘
            // 就是上面注释里那个 bug）。状态按「盘上还有没有待上传」给——连接那一刻
            // 内容已经对齐，通常是已同步。
            this.syncBackoffMs = 0;
            // ⚠️ 指纹要在**内容定下来之后**才落盘（采用方向会替换本机内容）：
            // 只在内存里设的话，连接后一刷新，loadSyncState 会读到「没上传过的
            // 指纹」而把同一份内容再传一次（云端 revision 白 +1）。
            this.syncUploadedPayloadKey = this.syncPayloadKey();
            await this.persistSyncConnection({ uploadedPayloadKey: this.syncUploadedPayloadKey });
            this.setSyncStatus('synced');
            this.notifySyncPeers('changed');
            this.startSyncPolling();
            this.showToast(direction === 'cloud' ? '已连接，已采用云端配置'
                : direction === 'reset' ? '已用新凭据继续同步'
                    : '已连接，已上传本机配置');
        }

        /** 「3 分钟前」这类相对时间。不走 Intl（首屏预算），也不引库。 */
        syncRelTime(timestamp) {
            const delta = Date.now() - Number(timestamp || 0);
            if (!Number.isFinite(delta) || delta < 60000) return '刚刚';
            if (delta < 3600000) return `${Math.floor(delta / 60000)} 分钟前`;
            if (delta < 86400000) return `${Math.floor(delta / 3600000)} 小时前`;
            return `${Math.floor(delta / 86400000)} 天前`;
        }

        async writeCloudConfig(token, revision) {
            return API.post('/api/sync/config', {
                revision,
                operationId: crypto.randomUUID(),
                config: window.NavigationSchema.publicConfig(structuredClone(this.config)),
                modules: this.localModulePayload()
            }, { token });
        }

        async adoptCloudConfig(cloud) {
            if (!cloud || !cloud.config) return;
            window.NavigationSchema.validate(cloud.config);
            if (await this.saveLocalNavigation(cloud.config) === false) throw new Error('本机导航未保存，已取消采用云端配置');
            this.config = structuredClone(cloud.config);
            // 模块偏好走与「本机模块开关」同一条写路径（队列 + 白名单 + 乐观并发），
            // 不另开一条：两条写同一份记录必然漂移。
            this.applyTheme();
            this.render();
            if (this.editLayout) this.renderLocalSettings();
        }

        exportSyncRecovery() {
            if (!this.syncRecovery) return;
            const payload = { schemaVersion: 1, direction: this.syncRecovery.direction, savedAt: this.syncRecovery.savedAt, config: this.syncRecovery.config, modules: this.syncRecovery.modules };
            const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
            const link = document.createElement('a');
            link.href = URL.createObjectURL(blob);
            link.download = 'pabu-sync-recovery.json';
            link.click();
            URL.revokeObjectURL(link.href);
        }

        /** 只挂页脚入口。对话框本体是临开临建的，监听器在那时挂（见 openSyncDialog）。 */
        bindSyncDialog() {
            const button = $('#syncBtn');
            if (button) button.onclick = () => this.openSyncDialog();
        }

        // ==================== 口令空间：自动同步与冲突 ====================
        //
        // 与上面「连接流程」那个状态机是两个轴：`syncState` 是对话框走到哪一步，
        // `syncStatus` 是**数据**的状态（设计文档 §5 的六个词）。别合并。
        //
        // 四条不能改坏的约定（都有用例钉着）：
        //   1. **先落盘再发**：待上传内容与 operationId 在 POST 之前写进 IndexedDB，
        //      响应丢了/页面关了，重启还能用同一个 ID 重放（服务端同 ID 同内容
        //      返回原结果，不重复写）。
        //   2. **单飞**：本标签页一次只有一个上传在途，跨标签页靠记录里的 claim。
        //      在途期间的新改动只置一个「还有下一轮」，绝不开第二条连接。
        //   3. **迟到不覆盖**：每个在飞的读/写都记下发起时的「连接代次 + 本地修订」，
        //      回来时任何一个变了就整份丢弃——不采用、不清 pending、不改状态。
        //   4. **只有真成功才显示已同步**：服务端确认 **且** 此后没有新的本地修改。

        /**
         * 本机是否有「还没来得及同步的输入」。形状与管理员侧的 hasAdministratorDraft 相同。
         * ⚠️ 不含同步对话框自己（`#syncDialog`）：开着它只是看着状态，不是草稿——
         * 算进去的话，用户在对话框里站着不动，云端的新内容就永远采用不进来。
         */
        hasLocalDraft() {
            return !!this.editLayout || this.localSettingsChanged() || this.localPending > 0
                || !!document.querySelector('.ui-dialog-overlay:not(#syncDialog)');
        }

        /**
         * 没有待上传内容时的状态词：本机内容真的都上去了才是「已同步」。
         * 六词表里没有「在线但有未上传改动」这一项，那种情况用「同步中」
         * （它确实在等防抖/在途），离线才是「离线，待同步」。
         */
        syncSettledStatus() {
            if (this.syncUploadedPayloadKey === this.syncPayloadKey()) return 'synced';
            return navigator.onLine === false ? 'pending' : 'syncing';
        }

        setSyncStatus(status) {
            // ⚠️ 所有的状态变更都走这里（别处直接赋值 this.syncStatus 会绕过
            // markSyncEntry，症状是页脚停在「同步中」而对话框已经显示「已同步」）。
            if (this.syncStatus === status) { this.markSyncEntry(); return; }
            this.syncStatus = status;
            this.markSyncEntry();
            this.renderSyncDialog();
        }

        /** 本地持久化成功后**唯一**的同步触发点。 */
        markSyncDirty() {
            // 采用云端配置时也会走 saveLocalNavigation，那不是「本地新改动」——
            // 不挡掉就会「刚采用云端 → 立刻把同一份内容再传回去」，白跑一趟
            // 还可能跟别的设备抢 revision。判据是这次保存的**来源**。
            if (this.syncAdopting) return;
            if (!this.syncConnection || !this.canRunOrdinarySync() || this.localUnavailable) return;
            if (this.syncStatus === 'conflict') return;   // 冲突未决时不动，等用户选
            if (this.syncHalted) return;   // 空间已停用
            this.setSyncStatus(navigator.onLine === false ? 'pending' : 'syncing');
            this.scheduleSyncUpload();
        }

        /**
         * 排一次上传：500ms 防抖 + 2s 上限。
         *
         * 两个定时器是**一起**用的：防抖保证「连续敲键盘只传一次」，上限保证
         * 「一直敲就一直不传」。只有防抖的话，用户连续编辑 10 秒，云端 10 秒
         * 都拿不到东西；只有上限的话，每 2 秒都会发一次。
         */
        scheduleSyncUpload() {
            if (!this.syncConnection || !this.canRunOrdinarySync() || this.syncStatus === 'conflict') return;
            if (this.syncHalted) return;
            clearTimeout(this.syncDebounceTimer);
            this.syncDebounceTimer = setTimeout(() => this.startSyncUpload(), SYNC_DEBOUNCE_MS);
            // ⚠️ 上限只在**本批第一次脏**时起算：已经排着就不再重置，
            // 否则连续改动会一直把它往后推，等于没有上限。
            if (!this.syncMaxWaitTimer) {
                this.syncMaxWaitTimer = setTimeout(() => this.startSyncUpload(), SYNC_MAX_WAIT_MS);
            }
        }

        startSyncUpload() {
            if (!this.canRunOrdinarySync()) return;
            clearTimeout(this.syncDebounceTimer); this.syncDebounceTimer = null;
            clearTimeout(this.syncMaxWaitTimer); this.syncMaxWaitTimer = null;
            clearTimeout(this.syncRetryTimer); this.syncRetryTimer = null;
            return this.uploadOnce();
        }

        /** 退避：1s 起翻倍，封顶 5 分钟；成功后归零。 */
        syncBackoffNext() {
            this.syncBackoffMs = this.syncBackoffMs ? Math.min(this.syncBackoffMs * 2, SYNC_BACKOFF_MAX_MS) : SYNC_BACKOFF_START_MS;
            return this.syncBackoffMs;
        }

        scheduleSyncRetry() {
            if (!this.syncConnection) return;
            const wait = this.syncBackoffNext();
            clearTimeout(this.syncRetryTimer);
            this.syncRetryTimer = setTimeout(() => this.startSyncUpload(), wait);
            return wait;
        }

        syncPayload() {
            return {
                config: window.NavigationSchema.publicConfig(structuredClone(this.config)),
                modules: this.localModulePayload()
            };
        }

        /**
         * 待同步内容的**指纹**。「已同步」与「上传确认的是哪一版」都按它比对。
         *
         * ⚠️ 为什么不用 `this.localRevision`：那只是**导航**那条记录的修订号，
         * 模块开关/布局改了它不动——于是「模块改完还没传上去」会被判成已同步，
         * 上传在途期间的模块改动也检测不到（浏览器审查抓到的正是这条）。
         * 指纹是纯函数、跨重启稳定，也不需要在多个计数器之间同步。
         * 用 FNV-1a（32 位）够用：它只决定**状态显示**，服务端的 revision 才是真相；
         * 真撞了也只是显示成「已同步」而实际还没传，而下一轮仍会传。
         */
        syncPayloadKey() {
            const text = JSON.stringify(this.syncPayload());
            let hash = 0x811c9dc5;
            for (let i = 0; i < text.length; i++) {
                hash ^= text.charCodeAt(i);
                hash = Math.imul(hash, 0x01000193) >>> 0;
            }
            return `${text.length}:${hash.toString(16)}`;
        }

        /** 内容相等：整份比较，不做逐字段合并（设计明确要求整份选择）。 */
        syncContentEqual(a, b) {
            return !!a && !!b
                && JSON.stringify(window.NavigationSchema.publicConfig(structuredClone(a))) === JSON.stringify(window.NavigationSchema.publicConfig(structuredClone(b)));
        }

        /**
         * 落盘同步记录。**一律带上当前连接代次**作为期望值：写事务里比较，
         * 代次被别的路径（停止/删除/另一个标签页）推进过就整份作废。
         * 这是验收「所有连接落盘和任务入队均事务比较代次」的落点——所以**不要**
         * 直接调 `localStore.writeSync`，只有「推进代次的那些操作」才用
         * `writeSyncWithEpochRetry`（它知道自己在换代次）。
         */
        async persistSyncRecord(patch) {
            if (!this.localStore) throw new Error('本地存储不可用');
            const record = await this.localStore.writeSync(patch, this.syncRecordRevision, this.syncConnEpoch || 0);
            this.syncRecordRevision = record.revision;
            this.syncConnEpoch = record.connEpoch;
            this.syncConnection = record.connection;
            this.syncRecovery = record.recovery;
            this.syncPending = record.pending;
            this.syncClaim = record.claim;
            this.syncLastSuccessAt = record.lastSuccessAt;
            return record;
        }

        /** 盘上先有 pending 再发出去——这是「响应丢了也能重放」的全部含义。 */
        async ensureSyncPending() {
            if (this.syncPending) return this.syncPending;
            const pending = {
                operationId: crypto.randomUUID(),
                content: this.syncPayload(),
                payloadKey: this.syncPayloadKey(),
                baseRevision: this.syncCloud?.revision ?? this.syncConnection.revision,
                createdAt: Date.now()
            };
            const record = await this.persistSyncRecord({ pending });
            return record.pending;
        }

        /**
         * 多标签页单飞：在**同一个事务**里写 pending + claim。
         *
         * 不用 `navigator.locks`：本仓库已经有一套「乐观 revision + BroadcastChannel」，
         * 再加一把只有部分浏览器支持的锁，就会有两套协调机制，而两套必然漂移。
         * `writeSync` 本身就是比较并设置（revision 不匹配就 conflict），所以
         * 这里重读一次再决定就够了——读到别人的新鲜 claim 就不动手。
         */
        async acquireSyncClaim() {
            for (let attempt = 0; attempt < 2; attempt++) {
                let record;
                try { record = await this.localStore.readSync(); }
                catch (error) { throw new Error('未能读取本机同步状态：' + error.message); }
                this.syncRecordRevision = record?.revision || 0;
                // 代次也要读回内存：只跟修订号的话，代次落后时这条落盘永远被拒，
                // 上传就卡在「失败 + 无限退避」，而恢复实际上依赖 BroadcastChannel 送达
                // ——架构文档明说正确性不靠它。
                this.syncConnEpoch = record?.connEpoch || 0;
                const claim = record?.claim;
                // 别人的认领还没过期 → 先**问一声**它是不是还活着，别只看时间戳。
                // 只看时间戳的话，关掉页面再重开（新标签页、新 id）会读到上一条
                // 残留的认领，于是白等最多 15 秒才动手（浏览器实测：重开后
                // 十几秒内那次改动一直没上传）。真正活着的标签页会在 300ms 内
                // 回一声；没人回就接手——索引的 CAS 与服务端的 revision 校验
                // 仍然是最终兜底。
                if (claim && claim.id !== this.syncTabId && Date.now() - claim.at < SYNC_CLAIM_TTL_MS) {
                    if (await this.syncClaimHeldElsewhere(claim.id)) return false;
                }
                try {
                    const written = await this.persistSyncRecord({ pending: this.syncPending, claim: { id: this.syncTabId, at: Date.now() } });
                    return !!written.claim;
                } catch (error) {
                    if (error.code !== 'conflict') throw error;   // 别的标签页刚改过 → 重读一次再判
                }
            }
            return false;
        }

        /** 向其他标签页问一声「这个认领还是你的吗」。没人回答 = 那个标签页已经不在了。 */
        syncClaimHeldElsewhere(claimId) {
            if (!this.syncChannel) return Promise.resolve(false);
            return new Promise(resolve => {
                let answered = false;
                const onMessage = event => {
                    if (event.data && event.data.type === 'claim-held' && event.data.id === claimId) answered = true;
                };
                this.syncChannel.addEventListener('message', onMessage);
                setTimeout(() => {
                    this.syncChannel.removeEventListener('message', onMessage);
                    resolve(answered);
                }, SYNC_CLAIM_PING_MS);
                this.syncChannel.postMessage({ type: 'claim-check', id: claimId });
            });
        }

        async releaseSyncClaim() {
            if (!this.syncClaim || this.syncClaim.id !== this.syncTabId) return;
            try { await this.persistSyncRecord({ claim: null }); }
            catch (error) { console.warn('释放上传认领失败:', error.message); }
        }

        /**
         * 一次上传。所有分支都在这里，别在别处再发 `/api/sync/config`。
         */
        async uploadOnce() {
            if (!this.syncConnection || this.syncStatus === 'conflict') return;
            // 空间停用期间绝不发上传：它是真正发请求的那一处，排程那一层的挡板
            // 挡不住「停用开始时已经排好但还没跑」的那一轮。
            if (this.syncHalted) return;
            // 单飞：本标签页已经有一个在途 → 只记「还有下一轮」，绝不并行第二条。
            if (this.syncUploadInFlight) { this.syncUploadAgain = true; return; }
            this.syncUploadInFlight = true;
            this.syncUploadAgain = false;
            const context = this.syncContextSnapshot();
            const epoch = context.conn;
            try {
                if (!await this.acquireSyncClaim()) { this.setSyncStatus('syncing'); return; }
                const pending = await this.ensureSyncPending();
                if (Date.now() - pending.createdAt > SYNC_RECEIPT_WINDOW_MS) {
                    // 回执过期：同 ID 再发会被当成**新**操作（可能把旧内容写回去），
                    // 所以先读一次核对，不盲目重提（设计 §5）。
                    if (await this.reconcileAgedPending(pending)) return;
                }
                this.setSyncStatus('syncing');
                const result = await API.post('/api/sync/config', {
                    revision: pending.baseRevision,
                    // 带上本机的连接代次：服务端在写事务里再比一次，不一致给
                    // 明确的 409 generation_mismatch，而不是笼统的 401。
                    generation: this.syncConnection.generation,
                    operationId: pending.operationId,
                    config: pending.content.config,
                    modules: pending.content.modules
                }, { token: this.syncConnection.deviceToken });
                if (!this.syncContextHeld(context)) return;   // 连接或身份上下文换过：这份结果作废
                await this.confirmSyncUpload(pending, result);
            } catch (error) {
                if (!this.syncContextHeld(context)) return;
                await this.handleSyncUploadFailure(error);
            } finally {
                this.syncUploadInFlight = false;
                // 连接或身份上下文换过（被清掉/重新连接/登录管理员）就**不要**再碰记录了：
                // 此刻那条记录可能已经属于新的连接或另一个身份，写进去会把旧状态带回来。
                if (this.syncContextHeld(context)) {
                    await this.releaseSyncClaim();
                    if (this.syncUploadSettled) {
                        this.syncUploadSettled = false;
                        await this.syncPullCheck();
                    }
                }
                if (this.syncUploadAgain && this.syncStatus !== 'conflict') {
                    this.syncUploadAgain = false;
                    this.scheduleSyncUpload();
                }
            }
        }

        /**
         * 成功收尾。
         *
         * ⚠️ 两件事分清楚：**确认的是「实际发出的那一版」**，不是「现在的本机」。
         * 上传在途时用户可能又改了——那时 pending 不能清（清了新改动就永远不上传），
         * 只把它的基线换成刚拿到的 revision，并在下一轮再传。
         */
        async confirmSyncUpload(pending, result) {
            const settled = pending.payloadKey === this.syncPayloadKey();
            const connection = {
                ...this.syncConnection,
                revision: result.revision,
                generation: result.generation ?? this.syncConnection.generation
            };
            // ⚠️ **无论是否 settled 都清掉 pending**。这一条踩过：
            //   · 留着它并只改 baseRevision，下轮就是「同一个 operationId + 不同内容」
            //     ——服务端摘要里带着基线版本，于是直接 409 operation_conflict；
            //   · 若连基线也不改，服务端会把这次当**重放**返回原结果，于是上传在途
            //     期间产生的那些新改动**永远传不上去**（每轮都在重放旧内容）。
            // 正确语义：这份内容已经落上去了，之后的新内容由下一轮**重新打包**
            // （新的 operationId、新的基线）——「同 ID 只能用在同一份内容上」。
            await this.persistSyncRecord({
                connection,
                pending: null,
                uploadedPayloadKey: pending.payloadKey,
                lastSuccessAt: Date.now()
            });
            // 这一次确认的是 pending.payloadKey 那一版；后来的改动还没上去。
            this.syncUploadedPayloadKey = pending.payloadKey;
            this.syncBackoffMs = 0;
            if (settled) {
                this.setSyncStatus('synced');
            } else {
                this.setSyncStatus(navigator.onLine === false ? 'pending' : 'syncing');
                this.scheduleSyncUpload();
            }
            this.notifySyncPeers('changed');
            // ⚠️ 回执返回的是**那次提交**的结果，不是现状（可能是重放，revision 比
            // 现在低）。所以成功之后必须再读一次，别把回执当成最新全量配置。
            // 但这次读取要等**在途闩放下之后**再发（见 uploadOnce 的 finally）：
            // 在闩还立着时读，pull 会看到「有上传在途」而把状态降级成待同步——
            // 症状是每次成功上传后界面都显示「待同步」，正是验收要挡的那一条。
            this.syncUploadSettled = true;
        }

        async handleSyncUploadFailure(error) {
            // 终态错误（空间被删 / 设备被撤销 / 令牌过期 / 空间停用）先拦掉：
            // 它们不该退避重试，也不该塌成同一句「连接已失效」——用户看到的
            // 下一句话完全不同（要不要重新输口令、要不要等管理员）。
            if (await this.handleSyncTerminal(error)) return;
            // 代次被别的标签页推进过（广播可能没送达：没有 BroadcastChannel 的浏览器，
            // 或者消息丢了）→ 重读一次记录、排下一轮，而不是当成网络失败去无限退避。
            if (error.code === 'epoch') {
                await this.refreshSyncRecord();
                this.setSyncStatus(this.syncConnection ? this.syncSettledStatus() : 'local');
                if (this.syncPending || this.syncPayloadKey() !== this.syncUploadedPayloadKey) this.scheduleSyncUpload();
                return;
            }
            if (error.status === 401 || error.status === 403) {
                await this.clearSyncConnection('连接已失效，请重新输入口令');
                return;
            }
            if (error.status === 409 && error.code === 'operation_conflict') {
                // 同一个 operationId 配了不同内容：这是客户端 bug（不该发生）。
                // 丢弃 pending 并**说出来**，不静默重试——静默重试会一直 409。
                await this.persistSyncRecord({ pending: null });
                this.setSyncStatus('failed');
                this.showToast('同步失败：本地待上传记录与已提交内容不一致，请重新编辑一次', 'error', 8000);
                return;
            }
            if (error.status === 409 && error.code === 'generation_mismatch') {
                await this.clearSyncConnection('设备授权已变化，请重新输入口令');
                return;
            }
            if (error.status === 409) return this.handleSyncConflict();
            // 额度用尽（503 `space_quota_exceeded`）：**不排退避、不丢 pending、不清连接**。
            // 退避重试在这里是错的——额度不会自己变松，退避只会对同一个 503 反复敲；
            // 而丢掉 pending 就等于把用户还没传上去的修改扔了（那是最不该丢的东西）。
            // 正确做法：保留待上传内容与连接，**明确告诉用户「写满了，先精简内容」**，
            // 由用户精简之后的下一次本地改动（`markSyncDirty` → 直接排一次）自己重试。
            if (error.status === 503 && error.code === 'space_quota_exceeded') {
                this.setSyncStatus('failed');
                this.showToast('云端空间的内容已达上限，未上传的修改仍在本机；请先精简导航或模块设置', 'error', 10000);
                return;
            }
            // 总暂停（503 `sync_paused`）走终态（halt）——由上面的 handleSyncTerminal 拦掉。
            // 到这里的 5xx 才是真正的服务端故障：保留 pending、退避重试。
            // 网络类失败：保留 pending，退避重试。离线时状态是「离线，待同步」。
            this.setSyncStatus(navigator.onLine === false ? 'pending' : 'failed');
            this.scheduleSyncRetry();
        }

        /**
         * 停止同步（确认之后）。
         *
         * 本地断开本身在 `clearSyncConnection` 里一次事务做完；这里只负责交互
         * （忙态、收尾文案）与**尽力**撤销服务端那一条令牌——离线时它失败不影响
         * 断开，所以不 await 结果，也不把它变成用户可见的错误。
         */
        async confirmStopSync() {
            if (this.syncBusy) return;
            this.syncBusy = true;
            this.renderSyncDialog();
            let failed = false;
            try { await this.stopSyncLocal(); }
            catch (error) { failed = true; this.setSyncState('error', '停止同步失败：' + error.message); }
            this.syncBusy = false;
            if (!failed) {
                this.setSyncState('disconnected');
                this.showToast('已停止同步，本机导航保持不变', 'success', 5000);
            }
            this.renderSyncDialog();
        }

        /** 停用/总暂停后的「重试同步」：再读一次，成功就回到已连接态。 */
        async retrySyncAfterHalt() {
            if (this.syncBusy) return;
            this.syncBusy = true;
            this.renderSyncDialog();
            await this.syncPullCheck();
            this.syncBusy = false;
            if (!this.syncHalted) this.setSyncState('connected');
            else this.renderSyncDialog();
        }

        /** 进入「撤销全部旧设备」确认态。**在线是硬要求**（与删除同理：这个动作要在服务端发生）。 */
        requestResetDevices() {
            if (navigator.onLine === false) {
                this.syncError = '撤销旧设备需要在线：离线时无法确认结果';
                this.renderSyncDialog();
                return;
            }
            this.syncError = '';
            this.setSyncState('confirm_reset');
        }

        /**
         * 确认「撤销全部旧设备并重新连接」。
         *
         * 顺序与取舍（每一条都对应设计 §5 的一句）：
         *   ① `operationId` **只放内存**（`this.syncResetOperationId`）：一次确认里
         *      的重试复用同一个 ID，服务端按它保证「只撤一次」。刷新页面重来会生成
         *      新的 ID、也就再撤一次——代价是多一枚 90 天内清理的孤儿令牌，
         *      把 ID 落进 IndexedDB 会让它多出一份与连接代次重叠的状态（必然漂移）。
         *   ② 拿到新材料后走 `finishSyncConnection(material, 'local')` —— 与首次连接
         *      同一条收尾路径，所以凭据落盘、指纹落盘、代次递增这些规矩自动成立。
         *      为什么要「重新连接」：服务端撤销了旧令牌并签发新的，本机必须换成新令牌。
         *   ③ **成功后先协调版本再同步**：这里**不**直接上传。内容若与云端不同，
         *      下一次拉取自然会摆出两份候选（`handleSyncConflict` 那条路），
         *      用户选完才落地——绝不在撤销之后顺手把本机内容盖上去。
         */
        async confirmResetDevices() {
            if (this.syncBusy || !this.syncConnection) return;
            const input = document.getElementById('syncResetPassphrase');
            const passphrase = input ? input.value : '';
            const verdict = this.validateSyncPassphrase(passphrase);
            if (!verdict.ok) { this.syncError = verdict.reason; return this.renderSyncDialog(); }
            this.syncBusy = true;
            this.renderSyncDialog();
            // 一次确认内的重试复用同一个 ID（重试都从这一屏重发）。
            if (!this.syncResetOperationId) this.syncResetOperationId = crypto.randomUUID();
            let failure = '';
            let material = null;
            try {
                const proof = await this.deriveSyncProof(passphrase);
                const result = await API.post('/api/sync/device/reset', { proof, operationId: this.syncResetOperationId });
                material = result;
            } catch (error) {
                const terminal = this.syncTerminalOf(error);
                if (terminal && !terminal.disconnect) {
                    // 停用/总暂停：连接还留着，说清状态。
                    this.syncBusy = false;
                    if (terminal.halt) return this.applySyncHalt(terminal.halt, terminal.message);
                }
                failure = terminal ? terminal.message : '撤销失败：' + error.message;
            }
            if (!material) {
                this.syncBusy = false;
                this.syncError = failure || '撤销失败';
                return this.renderSyncDialog();
            }
            // 成功：换成本机新凭据。走与首次连接**同一条**收尾路径（`finishSyncConnection`），
            // 它会先落盘再置「已连接」，并把代次递增写进同一次事务。
            // 方向用 `local`：本机内容与云端内容都没被替换过，这里只是「同一台设备换了凭据」，
            // 所以不写 recovery（没有哪一份被覆盖）。
            this.syncResetOperationId = null;
            try {
                await this.finishSyncConnection({ spaceId: material.spaceId, deviceToken: material.deviceToken, generation: material.generation, revision: material.revision }, 'reset');
            } catch (error) {
                this.syncBusy = false;
                this.syncError = '已撤销旧设备，但本机未能保存新凭据：' + error.message;
                return this.renderSyncDialog();
            }
            this.syncBusy = false;
            if (this.syncState === 'confirm_reset') this.setSyncState('connected');
            this.showToast('已撤销全部旧设备，本机已用新凭据继续同步', 'success', 8000);
            // 先协调版本：拉一次。内容不同就会摆出两份候选（不静默覆盖）。
            await this.syncPullCheck();
            this.renderSyncDialog();
        }

        /**
         * 服务端错误码 → 「怎么处理 + 给用户一句什么话」。**只有这一处**做这个映射。
         *
         * 分成两种终态：
         *   · `disconnect` —— 这条连接再也用不了了（空间被删 / 本设备被撤销 /
         *     令牌过期或无效）：本地断开、**保留本地导航**、说清原因。设计明确
         *     要求这几条不能塌成同一句「连接已失效」：用户看到的下一句话完全不同。
         *   · `halt` —— 连接**本身**还在，只是空间被管理员停用：停自动重试、
         *     保留连接与本地配置，等用户主动重试或管理员恢复（设计 §7）。
         * 返回 null 表示不是终态错误，按普通失败交给退避重试。
         */
        syncTerminalOf(error) {
            const code = error && error.code;
            if (code === 'space_deleted') return { disconnect: true, message: '云端空间已被删除，已转为仅保存在本机' };
            if (code === 'device_revoked') return { disconnect: true, message: '这台设备已断开同步，请重新输入口令' };
            if (code === 'device_expired' || code === 'device_invalid') return { disconnect: true, message: '连接已失效，请重新输入口令' };
            // 两种「暂停」各自一句话、各自一个 halt 原因（`halt: 'disabled' | 'paused'`）：
            // 用户看到的下一句话完全不同——停用要等管理员重新启用这个空间，总暂停
            // 是整台服务器都停了（等一会儿，或者去问部署者）。合成一句就是让用户猜。
            if (code === 'space_disabled') return { halt: 'disabled', message: '该空间已被管理员停用，自动同步已暂停' };
            if (code === 'sync_paused') return { halt: 'paused', message: '同步服务已被管理员暂停，稍后会自动重试' };
            return null;
        }

        /** 终态错误的统一处理。返回 true 表示已经处理掉了（调用方别再做退避）。 */
        async handleSyncTerminal(error) {
            const terminal = this.syncTerminalOf(error);
            if (!terminal) return false;
            if (terminal.halt) { this.applySyncHalt(terminal.halt, terminal.message); return true; }
            if (!terminal.disconnect) return false;
            await this.clearSyncConnection(terminal.message);
            this.showToast(terminal.message, 'error', 8000);
            return true;
        }

        /**
         * 「空间被管理员停用」或「同步服务被总暂停」的落地：**停自动重试、保留
         * 连接与本地数据、把状态说出来**。
         *
         * ⚠️ 两种暂停共用这一个函数，但**各自的对话框文案不同**（`syncHaltReason`
         * 记下是哪一种）：停用要等管理员把这个空间重新启用；总暂停是整台服务停了，
         * 用户能做的事不一样。落到同一屏上是 #9 修过的那个真缺陷的翻版
         * （停用落到了「口令 + 再输一次」的表单上，而那里输口令没有用）。
         *
         * 解除路径都是同一条：读一次成功（`syncPullCheck` 的成功分支）。总暂停
         * 时轮询间隔换成 `SYNC_PAUSED_POLL_MS`（5 分钟，与服务端 `Retry-After`
         * 同值），所以**不需要用户做任何事**，恢复后自己会回来。
         */
        applySyncHalt(reason, message) {
            this.syncHalted = reason || 'disabled';
            this.stopSyncTimers();
            this.setSyncStatus('failed');
            this.setSyncState('halted', message);
            // 总暂停是**临时**的，所以起一个 5 分钟的策略轮询（用轮询定时器的槽位，
            // 但间隔不同）；空间停用则等着（管理员恢复后用户点「重试同步」）。
            if (this.syncHalted === 'paused') this.startSyncPolling(SYNC_PAUSED_POLL_MS);
            this.showToast(message, 'error', 8000);
        }

        /**
         * 409 之后先**核对**再报冲突。
         *
         * 直接弹「存在配置冲突」会把很多「其实已经落上去」的情况也报成冲突
         * （比如自己的上一次写成功了但响应丢了，这次带着旧基线重发）。所以先读
         * 一次：内容一致就说明目标状态已经达到，清掉 pending 收工。
         */
        async handleSyncConflict() {
            let cloud;
            try { cloud = await this.fetchSyncCloud(); }
            catch (error) { this.setSyncStatus('failed'); return; }
            const pending = this.syncPending;
            if (pending && this.syncContentEqual(pending.content.config, cloud.config)
                && JSON.stringify(pending.content.modules || {}) === JSON.stringify(cloud.modules || {})) {
                await this.persistSyncRecord({ connection: { ...this.syncConnection, revision: cloud.revision, generation: cloud.generation }, pending: null, lastSuccessAt: Date.now() });
                this.setSyncStatus('synced');
                return;
            }
            this.syncCloud = cloud;
            this.syncConflict = {
                local: pending ? pending.content : this.syncPayload(),
                cloud: { config: cloud.config, modules: cloud.modules },
                baseRevision: cloud.revision,
                updatedAt: cloud.updatedAt
            };
            this.setSyncStatus('conflict');
            if (!this.syncDialogEl) this.showToast('云端已有别的设备的修改，请打开「同步」选择保留哪一份', 'error', 8000);
        }

        async fetchSyncCloud() {
            const cloud = await API.get('/api/sync/config', { token: this.syncConnection.deviceToken });
            this.syncCloud = cloud;
            return cloud;
        }

        /** 回执窗口之外的 pending：先核对内容，一致就当作已生效，不同才进冲突。 */
        async reconcileAgedPending(pending) {
            let cloud;
            try { cloud = await this.fetchSyncCloud(); }
            catch (error) { this.setSyncStatus('pending'); this.scheduleSyncRetry(); return true; }
            if (this.syncContentEqual(pending.content.config, cloud.config)
                && JSON.stringify(pending.content.modules || {}) === JSON.stringify(cloud.modules || {})) {
                await this.persistSyncRecord({ connection: { ...this.syncConnection, revision: cloud.revision, generation: cloud.generation }, pending: null, lastSuccessAt: Date.now() });
                this.setSyncStatus('synced');
                return true;
            }
            await this.handleSyncConflict();
            return true;
        }

        /**
         * 一次检查（读）。四个触发点共用：打开、恢复可见、网络恢复、30 秒轮询。
         */
        async syncPullCheck() {
            if (!this.syncConnection || !this.canRunOrdinarySync()) return;
            if (this.syncChecking) return;
            this.syncChecking = true;
            const context = this.syncContextSnapshot();
            // ⚠️ 判据是**内容指纹**而不是 `localRevision`：后者只是导航那条记录的
            // 修订号，模块开关/布局改了它不动，于是「飞行期间的模块改动」检测不到、
            // 会被云端内容覆盖（审查抓到的）。指纹对两者都敏感。
            const payloadKey = this.syncPayloadKey();
            try {
                const cloud = await API.get('/api/sync/config', { token: this.syncConnection.deviceToken });
                // 迟到的响应一律丢弃：连接换过、身份上下文换过（登录/退出/过期），
                // 或者本机在飞行期间又改了。三条都要比——只比连接代次会让管理员
                // 上下文的响应落到普通存储里。
                if (!this.syncContextHeld(context)) return;
                this.syncCloud = cloud;
                if (this.syncHalted) {
                    // 读得动 = 这个连接又能用了（管理员把空间恢复了 / 总暂停结束了）：
                    // **先解除挡板**，再把停掉的调度接回来（回到正常的 30 秒档），
                    // 并补排停用期间一次都没排过的本地改动。
                    // 然后继续走正常流程——云端若更早就顺带采用，不必再等下一轮轮询。
                    this.syncHalted = null;
                    this.startSyncPolling();
                    if (this.syncPayloadKey() !== this.syncUploadedPayloadKey) this.scheduleSyncUpload();
                    if (this.syncState === 'halted') this.setSyncState('connected');
                }
                // 有本地修改时先检查版本、再提交或进入冲突（设计 §5 原文）。
                // 只看 `pending` 不够：登录前「已落盘但还没排上传」的那一版，
                // `pending` 是空的，而它正是最不该被静默覆盖的东西。
                const localDirty = this.syncPending || this.syncUploadInFlight
                    || this.syncUploadedPayloadKey !== this.syncPayloadKey();
                if (localDirty) {
                    this.setSyncStatus('syncing');
                    if (this.syncPending) this.scheduleSyncUpload();
                    else this.scheduleSyncUpload();
                    return;
                }
                if (payloadKey !== this.syncPayloadKey()) return;
                if (cloud.revision === this.syncConnection.revision) { this.setSyncStatus(this.syncSettledStatus()); return; }
                // 服务端的 revision 是单调的：读到更小的只可能是过期响应（或者
                // 我们刚写完的那一版回执），采用它等于把本机内容回退。直接忽略。
                if (cloud.revision < this.syncConnection.revision) { this.setSyncStatus(this.syncSettledStatus()); return; }
                if (this.hasLocalDraft()) {
                    // 草稿保护：云端更新了，但本机正在编辑/有未确认的对话框——
                    // 保留输入，只提示，不覆盖。
                    this.setSyncStatus(this.syncSettledStatus());
                    if (!this.syncDialogEl) this.showToast('云端配置已更新，当前编辑已保留', 'error', 8000);
                    return;
                }
                await this.applyCloudConfig(cloud);
                await this.persistSyncRecord({
                    connection: { ...this.syncConnection, revision: cloud.revision, generation: cloud.generation },
                    // 采用之后本机 == 云端，所以「已上传的本地修订号」取**采用后**的值
                    uploadedPayloadKey: this.syncPayloadKey(),
                    lastSuccessAt: Date.now()
                });
                this.setSyncStatus('synced');
            } catch (error) {
                if (!this.syncContextHeld(context)) return;
                if (await this.handleSyncTerminal(error)) return;
                this.setSyncStatus(navigator.onLine === false ? 'pending' : 'failed');
            } finally {
                this.syncChecking = false;
            }
        }

        /** 采用云端内容：先留被替换的那一份，再覆盖本机。 */
        async applyCloudConfig(cloud) {
            // ⚠️ 这一层是**最后一道**：`recovery` 取的是 `this.config`，而管理员上下文下
            // 那就是站点导航。若不在这里拦，那份内容会被写进普通同步记录。
            if (!this.canRunOrdinarySync()) return;
            this.syncAdopting = true;
            try {
                await this.persistSyncRecord({
                    recovery: { direction: 'local', savedAt: Date.now(), config: window.NavigationSchema.publicConfig(structuredClone(this.config)), modules: this.localModulePayload() }
                });
                await this.adoptCloudConfig(cloud);
            } finally {
                this.syncAdopting = false;
            }
            // 采用之后本机内容 == 云端内容，所以「已上传的指纹」就是当前值。
            this.syncUploadedPayloadKey = this.syncPayloadKey();
        }

        /**
         * 起轮询。默认 30 秒（设计 §5）；总暂停期间用 5 分钟那一档
         * （`SYNC_PAUSED_POLL_MS`，与服务端 503 的 `Retry-After` 同值）。
         *
         * ⚠️ 参数化而不是「两个定时器」：两个定时器会让「停轮询」只停掉其中一个，
         * 而症状是暂停期间仍在按 30 秒打接口——正好是总暂停要避免的事。
         */
        startSyncPolling(intervalMs = SYNC_POLL_MS) {
            this.stopSyncPolling();
            if (!this.syncConnection) return;
            this.syncPollMs = intervalMs;
            this.syncPollTimer = setInterval(() => { if (!document.hidden) this.syncPullCheck(); }, intervalMs);
        }

        stopSyncPolling() {
            if (this.syncPollTimer) { clearInterval(this.syncPollTimer); this.syncPollTimer = null; }
        }

        stopSyncTimers() {
            for (const key of ['syncDebounceTimer', 'syncMaxWaitTimer', 'syncRetryTimer']) {
                if (this[key]) { clearTimeout(this[key]); this[key] = null; }
            }
            this.stopSyncPolling();
        }

        /**
         * 普通同步能不能跑：身份探测已落定即可。管理员会话不再切换首页上下文，
         * 因此本地同步与是否登录管理后台无关。
         */
        canRunOrdinarySync() {
            return !this.identityPending;
        }

        /** 在飞请求的上下文快照：只认连接代次。管理员登录不再切换首页上下文。 */
        syncContextSnapshot() {
            return { conn: this.syncConnEpoch };
        }

        /** 落盘点：连接代次没变，且上下文仍然允许跑普通同步，才许写。 */
        syncContextHeld(snap) {
            return snap.conn === this.syncConnEpoch && this.canRunOrdinarySync();
        }

        // ---- 三个触发点的**函数体**单独抽出来（监听器只是转发）--------------
        // 抽出来的理由是可验证：内联箭头函数没法被用例执行，于是「恢复可见会取消
        // 退避」「隐藏会停轮询」这些事实只能靠读源码，变异也变不红（审查抓到过）。

        /** 页签可见性变化：恢复可见立即检查并起轮询；隐藏就停（设计 §5）。 */
        onSyncVisibilityChange() {
            if (document.hidden) { this.stopSyncPolling(); return; }
            // 用户回到页面就是「现在想同步」：顺手解除退避。
            this.syncBackoffMs = 0;
            clearTimeout(this.syncRetryTimer); this.syncRetryTimer = null;
            this.syncPullCheck();
            this.startSyncPolling();
            if (this.syncPending) this.scheduleSyncUpload();
        }

        /** 网络恢复：取消退避、立刻检查，再把断网期间积压的传出去。 */
        onSyncOnline() {
            this.syncBackoffMs = 0;
            clearTimeout(this.syncRetryTimer); this.syncRetryTimer = null;
            this.syncPullCheck();
            if (this.syncPending) this.scheduleSyncUpload();
        }

        /** 断网：有没传完的就明确显示「离线，待同步」。 */
        onSyncOffline() {
            if (this.syncConnection && this.syncPending) this.setSyncStatus('pending');
        }

        /** 「现在去看一眼」——正确性不依赖它（正确性靠 revision 与 claim）。 */
        notifySyncPeers(type) {
            this.syncChannel?.postMessage({ type, revision: this.syncConnection?.revision ?? null, localRevision: this.localRevision });
        }

        bindSyncChannel() {
            this.syncTabId = `tab-${crypto.randomUUID()}`;
            if (!('BroadcastChannel' in window)) return;
            this.syncChannel = new BroadcastChannel('pabu-space-sync');
            this.syncChannel.onmessage = event => {
                if (!event.data) return;
                // 有人问「这个认领还是你的吗」：只要我还持有就回一声。
                if (event.data.type === 'claim-check') {
                    if (this.syncClaim && this.syncClaim.id === event.data.id) this.syncChannel.postMessage({ type: 'claim-held', id: event.data.id });
                    return;
                }
                // 别的标签页停止/删除了连接：本机重新读一遍记录（此刻已经没有
                // 连接），于是停表、页脚回到「同步」——不需要用户刷新。
                // 正确性不靠这条消息：记录本身与连接代次才是判据。
                if (event.data.type === 'stopped') { this.refreshSyncRecord(); return; }
                if (event.data.type !== 'changed') return;
                // 别的标签页刚上传过：本机若无待上传改动就去看一眼，
                // 免得两边显示不同的内容。
                if (!this.syncPending && !this.syncUploadInFlight) this.syncPullCheck();
            };
        }

        /** 冲突裁决。两个方向都会先保住被覆盖的那一份。 */
        async resolveSyncConflict(direction) {
            const conflict = this.syncConflict;
            if (!conflict) return;
            if (direction === 'cloud') {
                let cloud;
                try { cloud = await this.fetchSyncCloud(); }
                catch (error) { this.setSyncStatus('conflict'); this.syncError = '读取云端失败：' + error.message; this.renderSyncDialog(); return; }
                if (cloud.revision !== conflict.baseRevision) {
                    // 期间云端又变了：重新摆一次候选，不改任何东西。
                    this.syncConflict = { local: conflict.local, cloud: { config: cloud.config, modules: cloud.modules }, baseRevision: cloud.revision, updatedAt: cloud.updatedAt };
                    this.setSyncStatus('conflict');
                    this.syncError = '云端又有了新的修改，请重新选择';
                    this.renderSyncDialog();
                    return;
                }
                this.syncConflict = null;
                await this.persistSyncRecord({ pending: null });
                await this.applyCloudConfig(cloud);
                await this.persistSyncRecord({ connection: { ...this.syncConnection, revision: cloud.revision, generation: cloud.generation }, lastSuccessAt: Date.now() });
                this.syncError = '';
                this.setSyncStatus('synced');
                this.showToast('已采用云端配置，本机被替换的那一份已保留');
                return;
            }
            // 保留本机：以**检查时**的云端 revision 为基线重提。云端若已再变，
            // 服务端会再给一次 409，那时重新摆候选并说明原因。
            // 被覆盖的是云端那一份 → 与「采用云端」方向对称，先把它留在本机。
            this.syncConflict = null;
            await this.persistSyncRecord({
                recovery: { direction: 'cloud', savedAt: Date.now(), config: conflict.cloud.config, modules: conflict.cloud.modules || {} },
                pending: {
                    operationId: crypto.randomUUID(),
                    content: conflict.local,
                    payloadKey: this.syncPayloadKey(),
                    baseRevision: conflict.baseRevision,
                    createdAt: Date.now()
                }
            });
            this.syncError = '';
            this.setSyncStatus(navigator.onLine === false ? 'pending' : 'syncing');
            await this.startSyncUpload();
        }

        exportSyncConflict() {
            if (!this.syncConflict) return;
            const payload = {
                schemaVersion: 1,
                exportedAt: Date.now(),
                cloud: { revision: this.syncConflict.baseRevision, config: this.syncConflict.cloud.config, modules: this.syncConflict.cloud.modules },
                local: { revision: this.localRevision, config: this.syncConflict.local.config, modules: this.syncConflict.local.modules }
            };
            const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
            const link = document.createElement('a');
            link.href = URL.createObjectURL(blob);
            link.download = 'pabu-sync-conflict.json';
            link.click();
            URL.revokeObjectURL(link.href);
        }

        localSettingsChanged() {
            return !!this.localSettingsDraft && LOCAL_SETTINGS_FIELDS.some(key => JSON.stringify(this.localSettingsDraft[key]) !== JSON.stringify(this.config[key]));
        }

        setLocalSettingsVisible(visible) {
            const tools = $('#localNavigationTools');
            if (!tools || this.localToolsVisible === visible) return;
            this.localToolsVisible = visible;
            tools.getAnimations().forEach(animation => animation.cancel());
            tools.style.overflow = '';
            if (visible) tools.hidden = false;
            else this.closeLocalSelects();
            tools.inert = !visible;
            if (matchMedia('(prefers-reduced-motion: reduce)').matches) { tools.hidden = !visible; return; }
            const height = tools.getBoundingClientRect().height;
            tools.style.overflow = 'clip';
            const animation = tools.animate([
                { height: `${visible ? 0 : height}px`, opacity: visible ? 0 : 1, transform: visible ? 'translateY(-8px)' : 'none' },
                { height: `${visible ? height : 0}px`, opacity: visible ? 1 : 0, transform: visible ? 'none' : 'translateY(-8px)' }
            ], { duration: 260, easing: 'cubic-bezier(.16,1,.3,1)' });
            animation.onfinish = () => { tools.hidden = !visible; tools.style.overflow = ''; };
        }

        setLocalDrawerOpen(open) {
            const tools = $('#localNavigationTools');
            this.closeLocalSelects();
            tools.dataset.open = String(open);
            $('#localSettingsToggle').setAttribute('aria-expanded', String(open));
            $('#localSettingsToggleText').textContent = open ? '收起设置' : '展开设置';
            $('#localSettingsForm').inert = !open;
            $('#localSettingsBody').setAttribute('aria-hidden', String(!open));
        }

        closeLocalSelects() {
            document.querySelectorAll('.local-select-menu:popover-open').forEach(menu => menu.hidePopover());
        }

        syncLocalSelects() {
            this.syncThemedSelects('#localSettingsForm');
        }

        syncAdminSelects() {
            this.syncThemedSelects('#modalBody .admin-panels', 'admin-select');
        }

        syncThemedSelects(rootSelector, extraClass = '') {
            for (const select of document.querySelectorAll(`${rootSelector} select`)) {
                let wrapper = select.closest('.local-select');
                if (!wrapper) {
                    wrapper = document.createElement('div');
                    wrapper.className = extraClass ? `local-select ${extraClass}` : 'local-select';
                    select.before(wrapper);
                    wrapper.append(select);
                    const label = select.closest('label') || document.querySelector(`label[for="${select.id}"]`);
                    const caption = label?.querySelector('span') || label;
                    if (caption) caption.id = `${select.id}Label`;
                    if (label) label.htmlFor = `${select.id}Button`;
                    const ariaLabel = caption ? '' : (select.getAttribute('aria-label') || '');
                    const buttonName = caption ? `aria-labelledby="${caption.id} ${select.id}Value"` : (ariaLabel ? `aria-label="${this.esc(ariaLabel)}"` : '');
                    const menuName = caption ? `aria-labelledby="${caption.id}"` : (ariaLabel ? `aria-label="${this.esc(ariaLabel)}"` : '');
                    wrapper.insertAdjacentHTML('beforeend', `<button type="button" class="local-select-button" id="${select.id}Button" role="combobox" aria-haspopup="listbox" aria-expanded="false" aria-controls="${select.id}Menu" ${buttonName}><span id="${select.id}Value"></span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5"/></svg></button><div class="local-select-menu" id="${select.id}Menu" popover="manual" role="listbox" ${menuName}></div>`);
                    select.hidden = true;
                    const button = wrapper.querySelector('button');
                    const menu = wrapper.querySelector('[role="listbox"]');
                    const highlight = index => {
                        const options = [...menu.children];
                        options.forEach((option, i) => option.classList.toggle('is-active', i === index));
                        button.setAttribute('aria-activedescendant', options[index]?.id || '');
                        const option = options[index];
                        if (option) {
                            const top = option.offsetTop;
                            const bottom = top + option.offsetHeight;
                            if (top < menu.scrollTop) menu.scrollTop = top;
                            else if (bottom > menu.scrollTop + menu.clientHeight) menu.scrollTop = bottom - menu.clientHeight;
                        }
                    };
                    const open = () => {
                        this.closeLocalSelects();
                        const rect = button.getBoundingClientRect();
                        const width = Math.min(Math.max(rect.width, DROPDOWN_MIN_WIDTH), innerWidth - 24);
                        menu.style.width = `${width}px`;
                        menu.style.left = `${Math.max(12, Math.min(rect.right - width, innerWidth - width - 12))}px`;
                        const below = innerHeight - rect.bottom - 12;
                        const above = rect.top - 12;
                        const upward = below < 180 && above > below;
                        menu.style.maxHeight = `${Math.max(44, Math.min(272, upward ? above - 8 : below - 8))}px`;
                        menu.style.top = upward ? 'auto' : `${rect.bottom + 6}px`;
                        menu.style.bottom = upward ? `${innerHeight - rect.top + 6}px` : 'auto';
                        menu.dataset.openedAt = String(performance.now());
                        menu.showPopover();
                        highlight(select.selectedIndex);
                    };
                    const choose = index => {
                        if (!select.options[index] || select.options[index].disabled) return;
                        select.selectedIndex = index;
                        button.querySelector('span').textContent = select.selectedOptions[0]?.textContent || '请选择';
                        [...menu.children].forEach((option, i) => option.setAttribute('aria-selected', String(i === index)));
                        select.dispatchEvent(new Event('change', { bubbles: true }));
                        menu.hidePopover();
                        button.focus({ preventScroll: true });
                    };
                    button.onclick = () => menu.matches(':popover-open') ? menu.hidePopover() : open();
                    menu.addEventListener('toggle', () => {
                        button.setAttribute('aria-expanded', String(menu.matches(':popover-open')));
                        if (!menu.matches(':popover-open')) button.removeAttribute('aria-activedescendant');
                    });
                    menu.onclick = event => {
                        const option = event.target.closest('[role="option"]');
                        if (option) choose(Number(option.dataset.index));
                    };
                    button.onkeydown = event => {
                        const expanded = menu.matches(':popover-open');
                        if (event.key === 'Escape' && expanded) {
                            event.preventDefault(); event.stopPropagation(); menu.hidePopover(); return;
                        }
                        if (event.key === 'Tab') { if (expanded) menu.hidePopover(); return; }
                        if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '].includes(event.key)) {
                            event.preventDefault();
                            if (!expanded) { open(); return; }
                            const current = [...menu.children].findIndex(option => option.classList.contains('is-active'));
                            if (event.key === 'Enter' || event.key === ' ') choose(current);
                            else highlight(event.key === 'Home' ? 0 : event.key === 'End' ? select.options.length - 1 : Math.max(0, Math.min(select.options.length - 1, current + (event.key === 'ArrowDown' ? 1 : -1))));
                        } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
                            event.preventDefault();
                            if (!expanded) open();
                            const index = [...select.options].findIndex(option => option.textContent.toLocaleLowerCase().startsWith(event.key.toLocaleLowerCase()));
                            if (index >= 0) highlight(index);
                        }
                    };
                } else if (extraClass && !wrapper.classList.contains(extraClass)) {
                    wrapper.classList.add(extraClass);
                }
                const button = wrapper.querySelector('button');
                button.disabled = select.disabled;
                wrapper.querySelector('button span').textContent = select.selectedOptions[0]?.textContent || '请选择';
                const menu = wrapper.querySelector('[role="listbox"]');
                menu.innerHTML = [...select.options].map((option, index) => `<button type="button" role="option" tabindex="-1" id="${select.id}Option${index}" data-index="${index}" style="--option-index:${index}" aria-selected="${option.selected}"${option.disabled ? ' disabled' : ''}><span>${this.esc(option.textContent)}</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4 10-10"/></svg></button>`).join('');
            }
        }

        renderLocalSettings() {
            const draft = this.localSettingsDraft = window.NavigationSchema.publicConfig(structuredClone(this.config));
            const select = $('#localCurrentEngine');
            const editor = $('#localEngineEditor');
            this.renderThemeStyleSelect($('#localThemeStyleSelect'), draft);
            $('#localThemeSelect').value = window.NavigationSchema.appearance(draft).mode;
            $('#localThemeSelect').disabled = !!window.NavigationSchema.THEMES[window.NavigationSchema.appearance(draft).style].mode;
            $('#localIconsToggle').checked = draft.showBookmarkIcons;
            $('#localSettingsError').hidden = true;
            const renderSelection = () => {
                select.innerHTML = draft.searchEngines.map(e => `<option value="${this.esc(e.id)}">${this.esc(e.name)}</option>`).join('');
                select.value = draft.searchEngine;
                this.syncLocalSelects();
            };
            const render = () => {
                editor.innerHTML = draft.searchEngines.map((e, i) => {
                    const position = `引擎 ${i + 1}`;
                    const [name, url] = ['name', 'url'].map((key, j) => {
                        const label = ['名称', '搜索地址'][j];
                        return `<input data-field="${key}" aria-label="${position} ${label}" aria-describedby="localEngineHint" value="${this.esc(e[key])}" ${key === 'url' ? 'type="url" spellcheck="false"' : 'type="text"'}>`;
                    });
                    // 默认项就在它自己的名称右侧标出来，与上方「默认搜索引擎」下拉同源。
                    // 默认项标记：每个引擎都留一个空槽，切默认时只改文本，不整表重绘
                    // （整表重绘会把正在输入的框和焦点一起换掉）。空槽由 :empty 隐藏。
                    const badge = `<span class="local-engine-badge">${e.id === draft.searchEngine ? '默认' : ''}</span>`;
                    // 操作是图标，可访问名与 title 都带上序号：图标本身读不出是给哪一项的。
                    const actions = [
                        ['up', '↑', '上移', i === 0],
                        ['down', '↓', '下移', i === draft.searchEngines.length - 1],
                        ['delete', '✕', '删除', draft.searchEngines.length === 1]
                    ].map(([action, glyph, label, disabled]) =>
                        `<button type="button" class="btn btn-sm" data-action="${action}" title="${label}" aria-label="${position} ${label}"${disabled ? ' disabled' : ''}>${glyph}</button>`).join('');
                    return `<div class="local-engine-item" data-index="${i}">`
                        + `<span class="local-engine-index" aria-hidden="true">${i + 1}</span>`
                        + `<div class="local-engine-name">${name}${badge}</div>`
                        + url
                        + `<div class="local-engine-actions">${actions}</div>`
                        + `</div>`;
                }).join('');
                $('#localEngineCount').textContent = `${draft.searchEngines.length} 个`;
                renderSelection();
            };
            // 事件委托都在 #localEngineEditor 上，行序号从最近的 .local-engine-item 读——
            // 引擎行已从 fieldset 改成一行一项的 div，选择器必须跟着走。
            const indexOf = event => +event.target.closest('.local-engine-item').dataset.index;
            editor.oninput = event => {
                const field = event.target.dataset.field;
                if (!field) return;
                draft.searchEngines[indexOf(event)][field] = event.target.value;
                renderSelection();
            };
            // 切换默认引擎只改动草稿与「默认」标记，不重绘整张表——
            // 重绘会把正在输入的框和焦点一起换掉。
            const syncDefaultBadge = () => {
                [...editor.children].forEach((row, i) => {
                    const badge = row.querySelector('.local-engine-badge');
                    if (badge) badge.textContent = draft.searchEngines[i]?.id === draft.searchEngine ? '默认' : '';
                });
            };
            select.onchange = () => { draft.searchEngine = select.value; syncDefaultBadge(); };
            $('#localThemeStyleSelect').onchange = event => {
                draft.themeStyle = event.target.value;
                $('#localThemeSelect').disabled = !!window.NavigationSchema.THEMES[draft.themeStyle].mode;
                $('#localThemeSelect').value = window.NavigationSchema.appearance(draft).mode;
            };
            $('#localThemeSelect').onchange = event => { draft.theme = event.target.value; };
            $('#localIconsToggle').onchange = event => { draft.showBookmarkIcons = event.target.checked; };
            editor.onclick = event => {
                const action = event.target.dataset.action;
                if (!action) return;
                const list = draft.searchEngines;
                const index = indexOf(event);
                if (action === 'delete' && list.length > 1) {
                    const [removed] = list.splice(index, 1);
                    if (removed.id === draft.searchEngine) draft.searchEngine = list[0].id;
                } else {
                    const target = action === 'up' ? index - 1 : index + 1;
                    if (target < 0 || target >= list.length) return;
                    [list[index], list[target]] = [list[target], list[index]];
                }
                render();
            };
            $('#localAddEngineBtn').onclick = () => {
                if (draft.searchEngines.length >= 50) { this.showToast('搜索引擎最多 50 个', 'error'); return; }
                draft.searchEngines.push({ id: uid(), name: '新引擎', url: 'https://' });
                render();
                editor.querySelector('.local-engine-item:last-child input').focus();
            };
            $('#localClearIconCacheBtn').onclick = () => this.clearBookmarkIconCache();
            render();
            this.syncLocalSelects();
            this.setLocalDrawerOpen(true);
        }

        /**
         * 普通访客的「模块」分组：列出管理员**已开放**的公开模块，
         * 逐个开关 + 由模块声明的偏好白名单生成的控件。
         *
         * 三个条件同时满足才有这一行：公开分类（注册时声明）、管理员开放
         * （服务端策略）、本机未撤回。这里是前两个的界面入口，第三个就是开关本身。
         */
        bindLocalNavigation() {
            this.setLocalStatus(this.localError || '仅保存在本机', !!this.localError);
            window.addEventListener('resize', () => this.closeLocalSelects());
            document.addEventListener('pointerdown', event => {
                if (!event.target.closest?.('.local-select, .home-theme-switcher')) this.closeLocalSelects();
            }, true);
            window.addEventListener('scroll', event => {
                if (!event.target.closest?.('.local-select-menu')) {
                    const openMenu = document.querySelector('.local-select-menu:popover-open');
                    // 打开菜单时的焦点/布局滚动会以 document 为目标冒泡到这里，不能把它当成用户滚动。
                    if (openMenu && performance.now() - Number(openMenu.dataset.openedAt || 0) < 300) return;
                    this.closeLocalSelects();
                }
            }, { capture: true, passive: true });
            $('#localSettingsToggle').onclick = () => this.setLocalDrawerOpen($('#localNavigationTools').dataset.open !== 'true');
            $('#localSettingsForm').addEventListener('change', () => this.syncLocalSelects());
            $('#localSettingsForm').onsubmit = event => { event.preventDefault(); this.saveEditSession(); };
            $('#localCancelBtn').onclick = () => this.cancelEditSession();
            $('#localUndoBtn').onclick = async () => {
                if (this.localSettingsChanged() && !await this.confirmAction('撤销将替换尚未保存的设置，是否继续？', '撤销上一操作')) return;
                await this.saveLocalNavigation(this.config, true);
            };
            $('#localExportBtn').onclick = () => this.exportLocalNavigation();
            $('#localImportBtn').onclick = () => $('#localImportFile').click();
            $('#localImportFile').onchange = event => { this.importLocalNavigation(event.target.files[0]); event.target.value = ''; };
            $('#localResetBtn').onclick = () => this.resetLocalNavigation();
            $('#localAdoptBtn').onclick = async () => {
                if (await this.confirmAction('放弃当前草稿并采用其他标签页已保存的版本？', '采用已保存版本')) {
                    this.localSettingsDraft = null;
                    this.exitEditLayout();
                    await this.refreshLocalNavigation(true);
                }
            };
            if ('BroadcastChannel' in window) {
                this.localChannel = new BroadcastChannel('pabu-local-navigation');
                this.localChannel.onmessage = () => this.refreshLocalNavigation();
            }
            window.addEventListener('beforeunload', event => {
                if (this.transferActive || this.localPending || this.localError || this.localSettingsChanged() || $('.ui-dialog-overlay input, .ui-dialog-overlay textarea')) { event.preventDefault(); event.returnValue = ''; }
            });
            window.addEventListener('focus', () => this.refreshLocalNavigation());
            window.addEventListener('online', () => this.checkAdministratorSync());
        }

        async init() {
            try {
                this.initialSession = this.loadSession();
                this.initialSession.catch(() => {});
                await this.loadLocalNavigation();
                this.migrateConfig();
                this.applyTheme();
                this.render();
                this.bind();
                if (this.adminPage) {
                    document.title = 'Pabu 管理后台';
                } else {
                    $('#loader').remove();
                    $('#app').hidden = false;
                }
                requestAnimationFrame(() => {
                    if (this.adminPage) this.openAdminPage();
                    else this.restoreSession();
                    this.loadSyncState();
                });
                const register = () => navigator.serviceWorker?.register('/sw.js').catch(error => console.warn('Service worker registration failed:', error));
                if (document.readyState === 'complete') register();
                else window.addEventListener('load', register, { once: true });
            } catch (e) {
                console.error('初始化失败:', e);
                $('#loader').remove();
                document.body.innerHTML = '<div style="padding:40px;text-align:center;color:#666">页面加载失败，请刷新重试</div>';
            }
        }

        migrateConfig() {
            if (this.config.bookmarks && !this.config.categories) {
                this.config.categories = this.config.bookmarks;
                delete this.config.bookmarks;
            }
            if (this.config.showBookmarkIcons === undefined) {
                this.config.showBookmarkIcons = false;
            }
            if (this.config.theme === undefined) {
                this.config.theme = 'auto';
            }
        }

        /**
         * 当前生效的外观。优先级：本机 localStorage → 本机导航配置 → auto。
         * 管理员会话不改变首页外观。
         */
        resolveTheme() {
            try {
                const stored = localStorage.getItem(THEME_STORAGE_KEY);
                if (APPEARANCE_ORDER.includes(stored)) return stored;
            } catch (e) {}
            return this.config.theme || 'auto';
        }

        renderHomeThemeSwitcher() {
            const host = $('#homeThemeSwitcher');
            if (!host || !this.config) return;
            const disabled = this.editLayout || this.themeStyleSaving;
            host.setAttribute('aria-busy', String(!!this.themeStyleSaving));
            this.renderThemeDropdown(host, {
                style: window.NavigationSchema.appearance(this.config).style,
                disabled,
                disabledTitle: '请先完成当前编辑或保存',
                optionAttr: 'data-home-theme',
                onSelect: id => this.setThemeStyle(id)
            });
            // 这里不再重量模块区顶端：主题入口在宽屏是绝对定位，在窄屏是常规流的
            // 一行，而窄屏模块区本就回到文档流、不参与定位，两种情况都不会挪动
            // 搜索框。顶线的重量在 renderModuleZone 与 resize 两处。
        }

        /**
         * 主题入口统一为「当前主题 + 向下菜单」。主题数量后续只会在
         * NavigationSchema.THEMES 里增加，菜单按注册表生成，新增主题无需改结构。
         * 首页快捷入口与后台画布共用这一个组件。
         */
        renderThemeDropdown(host, { style, disabled = false, disabledTitle = '切换视觉主题', optionAttr, onSelect }) {
            if (!host.children.length) {
                host.innerHTML = `
                    <button type="button" class="home-theme-trigger" id="${host.id}Trigger" role="combobox" aria-haspopup="listbox" aria-expanded="false" aria-controls="${host.id}Menu" aria-label="视觉主题">
                        <span class="home-theme-trigger-label" id="${host.id}Value"></span>
                    </button>
                    <div class="local-select-menu home-theme-menu" id="${host.id}Menu" popover="manual" role="listbox" aria-labelledby="${host.id}Value">
                        ${Object.entries(window.NavigationSchema.THEMES).map(([id, item], index) =>
                            `<button type="button" role="option" tabindex="-1" id="${host.id}Option-${id}" data-theme-option="${id}" ${optionAttr}="${id}" style="--option-index:${index}" aria-selected="false"><span>${this.esc(item.name)}</span></button>`).join('')}
                    </div>`;
                this.bindThemeDropdown(host);
            }
            host._themeSelect = onSelect;
            const trigger = host.querySelector('.home-theme-trigger');
            trigger.querySelector('.home-theme-trigger-label').textContent = window.NavigationSchema.THEMES[style]?.name || '';
            trigger.disabled = !!disabled;
            trigger.title = disabled ? disabledTitle : '切换视觉主题';
            for (const option of host.querySelectorAll('[role="option"]')) {
                option.setAttribute('aria-selected', String(option.dataset.themeOption === style));
                option.disabled = !!disabled;
            }
        }

        bindThemeDropdown(host) {
            const trigger = host.querySelector('.home-theme-trigger');
            const menu = host.querySelector('.home-theme-menu');
            const options = () => [...menu.children];
            const selectedIndex = () => Math.max(0, options().findIndex(option => option.getAttribute('aria-selected') === 'true'));
            const highlight = index => {
                const list = options();
                list.forEach((option, i) => option.classList.toggle('is-active', i === index));
                trigger.setAttribute('aria-activedescendant', list[index]?.id || '');
                const option = list[index];
                if (!option) return;
                const top = option.offsetTop;
                const bottom = top + option.offsetHeight;
                if (top < menu.scrollTop) menu.scrollTop = top;
                else if (bottom > menu.scrollTop + menu.clientHeight) menu.scrollTop = bottom - menu.clientHeight;
            };
            const close = (restoreFocus = false) => {
                if (menu.matches(':popover-open')) menu.hidePopover();
                if (restoreFocus) trigger.focus({ preventScroll: true });
            };
            const open = () => {
                if (trigger.disabled) return;
                document.querySelectorAll('.local-select-menu:popover-open').forEach(other => other.hidePopover());
                const rect = trigger.getBoundingClientRect();
                const width = Math.min(rect.width, innerWidth - 24);
                menu.style.width = `${width}px`;
                menu.style.left = `${Math.max(12, Math.min(rect.right - width, innerWidth - width - 12))}px`;
                const below = innerHeight - rect.bottom - 12;
                const above = rect.top - 12;
                const upward = below < 180 && above > below;
                menu.style.maxHeight = `${Math.max(44, Math.min(272, upward ? above - 8 : below - 8))}px`;
                menu.style.top = upward ? 'auto' : `${rect.bottom + 6}px`;
                menu.style.bottom = upward ? `${innerHeight - rect.top + 6}px` : 'auto';
                menu.style.transformOrigin = upward ? 'bottom right' : 'top right';
                menu.dataset.openedAt = String(performance.now());
                menu.showPopover();
                highlight(selectedIndex());
            };
            trigger.onclick = () => menu.matches(':popover-open') ? close() : open();
            trigger.onkeydown = event => {
                const expanded = menu.matches(':popover-open');
                if (event.key === 'Escape' && expanded) {
                    event.preventDefault(); event.stopPropagation(); close(true); return;
                }
                if (event.key === 'Tab') { if (expanded) close(); return; }
                if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '].includes(event.key)) return;
                event.preventDefault();
                if (!expanded) { open(); return; }
                const list = options();
                const current = list.findIndex(option => option.classList.contains('is-active'));
                if (event.key === 'Enter' || event.key === ' ') {
                    const option = list[current];
                    if (option && !option.disabled) { close(true); host._themeSelect?.(option.dataset.themeOption); }
                    return;
                }
                const next = event.key === 'Home' ? 0
                    : event.key === 'End' ? list.length - 1
                    : Math.max(0, Math.min(list.length - 1, current + (event.key === 'ArrowDown' ? 1 : -1)));
                highlight(next);
            };
            menu.addEventListener('toggle', () => {
                const expanded = menu.matches(':popover-open');
                trigger.setAttribute('aria-expanded', String(expanded));
                if (!expanded) {
                    trigger.removeAttribute('aria-activedescendant');
                    options().forEach(option => option.classList.remove('is-active'));
                }
            });
            menu.onclick = event => {
                const option = event.target.closest('[role="option"]');
                if (!option || option.disabled) return;
                close(true);
                host._themeSelect?.(option.dataset.themeOption);
            };
            document.addEventListener('pointerdown', event => {
                if (host.contains(event.target)) return;
                close();
            }, true);
        }

        async setThemeStyle(style) {
            if (!Object.hasOwn(window.NavigationSchema.THEMES, style) || this.themeStyleSaving || this.editLayout) return;
            if (window.NavigationSchema.appearance(this.config).style === style) return;
            const previous = this.config;
            const candidate = { ...previous, themeStyle: style };
            this.themeStyleSaving = true;
            this.config = candidate;
            this.applyTheme();
            try {
                if (!await this.saveLocalNavigation(candidate)) throw new Error('主题未能保存到本机');
            } catch (error) {
                if (this.config === candidate) {
                    this.config = previous;
                    this.applyTheme();
                    this.showToast(error.message + '，已还原原主题', 'error');
                }
            } finally {
                this.themeStyleSaving = false;
                this.renderHomeThemeSwitcher();
                $('#homeThemeSwitcherTrigger')?.focus({ preventScroll: true });
            }
        }

        renderThemeStyleSelect(select, config) {
            select.innerHTML = Object.entries(window.NavigationSchema.THEMES).map(([id, item]) =>
                `<option value="${id}">${this.esc(item.name)}${item.mode ? ` · ${item.mode === 'dark' ? '深色' : '浅色'}` : ''}</option>`).join('');
            select.value = window.NavigationSchema.appearance(config).style;
        }

        applyTheme() {
            const appearance = window.NavigationSchema.appearance({ ...this.config, theme: this.resolveTheme() });
            const theme = appearance.mode;
            const root = document.documentElement;
            root.dataset.themeStyle = appearance.style;
            // 只缓存本标签页的已生效外观，供独立分享页沿用，不参与配置保存。
            try { sessionStorage.setItem('pabu-appearance', JSON.stringify(appearance)); } catch (e) {}
            const fixed = !!window.NavigationSchema.THEMES[appearance.style].mode;
            const modeSelect = $('#themeModeSelect');
            if (modeSelect) { modeSelect.disabled = fixed; modeSelect.value = theme; }
            document.querySelectorAll('meta[name="theme-color"]').forEach(meta => {
                const dark = theme === 'dark' || (theme === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
                meta.content = appearance.style === 'prism' ? '#1b232b' : dark ? '#211f1c' : '#efede8';
                if (theme === 'auto') {
                    meta.content = meta.media.includes('dark') ? '#211f1c' : '#efede8';
                }
            });

            if (theme === 'auto') {
                // 跟随系统
                root.removeAttribute('data-theme');
            } else {
                // 强制指定主题
                root.setAttribute('data-theme', theme);
            }
            this.renderHomeThemeSwitcher();
        }

        render() {
            this.renderEngines();
            this.renderGrid();
        }

        renderEngines() {
            const current = this.config.searchEngines.find(e => e.id === this.config.searchEngine) || this.config.searchEngines[0];
            $('#engineName').textContent = current.name;
            $('#engineBtn').setAttribute('aria-label', `选择搜索引擎，当前为${current.name}`);

            const dropdown = $('#engineDropdown');
            dropdown.innerHTML = this.config.searchEngines.map((e, i) =>
                `<button type="button" role="option" aria-selected="${e.id === this.config.searchEngine}" class="engine-option${e.id === this.config.searchEngine ? ' active' : ''}" style="--option-index:${i}" data-id="${this.esc(e.id)}">${this.esc(e.name)}</button>`
            ).join('');
        }

        /**
         * 网格编辑表面：一份配置 + 一个宿主元素 + 一个可编辑判据 + 一个变更回调。
         *
         * 首页编辑只使用这一套表面，渲染与交互只有下面这一套方法
         * （renderGrid / bindGridEdit / bindTouchGridDrag / move* 都接受 surface）。
         * 复制一份拖拽代码必然漂移，这个仓库已经付过同形重复的代价。
         *
         * 约定：同一时刻只有一个表面处于可编辑态。后台面板是模态的，首页在它后面只读，
         * 所以两套 handler 按各自宿主绑定、互不串扰即可。
         */
        gridSurface({ getConfig, isEditing, host, changed }) {
            return { getConfig, isEditing, host, changed };
        }

        /** 取表面：显式传入 > 首页表面 > 现场兜底建一份。
         *  兜底那条是给测试夹具用的——有些用例用 Object.create 绕过构造函数，
         *  this.homeSurface 不存在，默认参数会直接抛 TypeError。 */
        surfaceOf(surface) {
            if (surface) return surface;
            if (!this.homeSurface) {
                this.homeSurface = this.gridSurface({
                    getConfig: () => this.config,
                    isEditing: () => this.editLayout,
                    host: $('#grid'),
                    changed: this.saveLocalNavigation.bind(this)
                });
            }
            return this.homeSurface;
        }

        renderGrid(surface = this.homeSurface) {
            surface = this.surfaceOf(surface);
            const grid = surface.host;
            const fragment = document.createDocumentFragment();
            // 编辑态多生成两类节点：分类头的手柄/删除按钮，与每类末尾的
            // ＋占位卡。**不进编辑态的模板与改动前逐字相同**，
            // 所以正常访问的首页零回归。
            const editing = surface.isEditing();
            // ⚠️ 分类的拖拽宿主必须是 **.category-header**，不是那个 ⠿ 按钮，
            // 也**不能是整块 <section>**。两条都是实测出来的：
            //  1. <button> 不可拖拽，原生 DnD 只从最近的 draggable 起手，
            //     所以把手上没有 draggable 时一个 dragstart 都不发（实测 0 事件）。
            //  2. 反过来把 draggable 挂到整块 section 上，section 内部**任何**
            //     位置按下都会起拖——包括 ✎ 重命名与 ✕ 删除。那两个按钮于是
            //     变成「按住横拖 = 起拖 → 浏览器按规范抑制随后的 click →
            //     对话框打不开」，比改前更糟（改前根本不起拖，按钮是好的）。
            // 所以宿主收窄到分类头：**可拖的区域**与**分流判据**落在同一处，
            // 而 ✎/✕ 作为 draggable=false 的后代，在按钮上按下不会起拖。
            // 代价是 dragstart.target 解析到 .category-header，
            // 「拖分类」与「拖书签」在该事件上无法区分（书签卡是 section 的子节点、
            // 也是 draggable，命中它时 target 就是 <a> 本身）——
            // 分流靠 pointerdown 记住的真实落点。
            surface.getConfig().categories.forEach((cat, catIdx) => {
                const section = html(`
                    <section class="category" data-cat="${catIdx}">
                        <div class="category-header"${editing ? ' draggable="true"' : ''}>
                            <h2 class="category-title">${this.esc(cat.name)}</h2>
                            ${editing ? `<button type="button" class="category-action category-drag" title="拖拽调整分类顺序" aria-label="拖拽调整分类顺序">⠿</button>
                            <button type="button" class="category-action category-edit" data-edit-cat="${catIdx}" title="重命名分类">✎</button>
                            <button type="button" class="category-action category-del" data-del-cat="${catIdx}" title="删除分类" aria-label="删除分类 ${this.esc(cat.name)}">✕</button>` : ''}
                        </div>
                        <div class="bookmarks"></div>
                    </section>
                `);
                const bms = $('.bookmarks', section);
                cat.bookmarks.forEach((bm, bmIdx) => {
                    bms.appendChild(this.createBookmark(bm, catIdx, bmIdx, surface));
                });
                if (editing) {
                    bms.appendChild(html(`<button type="button" class="bookmark bookmark-add" data-add-cat="${catIdx}" title="为「${this.esc(cat.name)}」添加导航" aria-label="为 ${this.esc(cat.name)} 添加导航">＋</button>`));
                }
                fragment.appendChild(section);
            });
            if (editing) {
                fragment.appendChild(html(`<button type="button" class="category-add">＋ 添加分类</button>`));
            }
            for (const img of grid.querySelectorAll('.bookmark-icon[data-icon-mode]')) {
                this.bookmarkIconObserver?.unobserve(this.bookmarkIconObserverTarget(img));
                this.cancelBookmarkIcon(img);
                const objectUrl = this.bookmarkIconObjectUrls.get(img);
                if (objectUrl) { URL.revokeObjectURL(objectUrl); this.bookmarkIconObjectUrls.delete(img); }
                img.onload = img.onerror = null;
                img.removeAttribute('src');
            }
            grid.replaceChildren(fragment);
            for (const img of grid.querySelectorAll('.bookmark-icon[data-icon-mode]')) {
                if (this.bookmarkIconObserver) this.bookmarkIconObserver.observe(this.bookmarkIconObserverTarget(img));
                else this.queueBookmarkIcon(img, 0);
            }
        }

        createBookmark(bm, catIdx, bmIdx, surface = this.homeSurface) {
            surface = this.surfaceOf(surface);
            // 编辑态下 data-cat/data-bm 是拖拽与增删改的定位依据；
            // 非编辑态不写，首页 DOM 与改动前完全一致。
            const editing = surface.isEditing();
            const attrs = editing ? ` data-cat="${catIdx}" data-bm="${bmIdx}" draggable="true"` : '';
            // 删除按钮压在卡的右上角：整张卡是拖拽宿主，按钮必须自己
            // stopPropagation，否则拖拽起手会把它一起带走。
            const del = editing
                ? `<button type="button" class="bookmark-del" data-del-bm="${bmIdx}" title="删除导航" aria-label="删除导航 ${this.esc(bm.title)}">✕</button>`
                : '';
            // 导航书签默认不显示图标，只有显式开启 true 时才显示。
            // 显示图标时，图标位置位于文字左侧，获取网站的真实图片并裁剪缩放为统一合适大小和形状。
            // 图片加载失败时回退到首字字母牌。
            const showIcons = surface.getConfig().showBookmarkIcons === true;
            const initial = Array.from(String(bm.title || '').trim())[0] || '?';
            let iconMode = 'auto';
            try { if (bm.iconUrl) iconMode = 'custom'; else if (this.bookmarkIconIsPrivate(new URL(bm.url))) iconMode = 'local'; } catch {}
            const iconUrl = bm.iconUrl || bm.url;
            const icon = showIcons
                ? `<img class="bookmark-icon" data-icon-mode="${iconMode}" data-bookmark-url="${this.esc(iconUrl)}"${bm.iconUrl ? ` data-icon-url="${this.esc(bm.iconUrl)}"` : ''} data-icon-state="idle" style="display:none" alt="" aria-hidden="true" loading="lazy" decoding="async" draggable="false"><span class="bookmark-icon bookmark-icon-fallback" aria-hidden="true">${this.esc(initial.toUpperCase())}</span>`
                : '';
            return html(`
                <a class="bookmark${showIcons ? ' has-icon' : ' bookmark-text-only'}"${attrs} href="${this.esc(bm.url)}" target="_blank" rel="noopener" title="${this.esc(bm.title)}">
                    ${icon}<span class="bookmark-title">${this.esc(bm.title)}</span>${del}
                </a>
            `);
        }

        bind() {
            this.bindLocalNavigation();
            this.bindSyncDialog();
            this.syncEditEntries();
            const identityChanged = () => this.checkAdministratorSync();
            window.addEventListener('storage', event => { if (event.key === 'pabu-auth-reset') identityChanged(); });
            if ('BroadcastChannel' in window) { this.authChannel = new BroadcastChannel('pabu-auth'); this.authChannel.onmessage = identityChanged; }
            setInterval(() => { if (!document.hidden) this.checkAdministratorSync(); }, 30000);
            document.addEventListener('visibilitychange', () => { if (!document.hidden) this.checkAdministratorSync(); this.onSyncVisibilityChange(); });
            window.addEventListener('online', () => this.onSyncOnline());
            window.addEventListener('offline', () => this.onSyncOffline());
            $('#modeBtn').onclick = () => this.exitPasteMode();
            this.bindPointerEffects();
            this.bindKeyboardViewport();
            this.bindBookmarkPress();
            this.bindGridEdit();
            $('#searchForm').onsubmit = event => { event.preventDefault(); this.handleSearch(); };
            const input = $('#searchInput');
            input.addEventListener('keydown', event => {
                if (event.key !== 'Enter') return;
                if (this.pasteMode && (event.shiftKey || event.ctrlKey || event.metaKey)) return;
                if (!event.shiftKey && !event.ctrlKey && !event.metaKey) { event.preventDefault(); this.handleSearch(); }
            });
            input.oninput = event => { this.handleSearchInput(event); this.autoGrowPasteInput(); };
            input.addEventListener('paste', event => {
                if (this.pasteMode) return;
                const pickup = this.parsePickup(event.clipboardData?.getData('text') || '');
                if (!pickup) return;
                event.preventDefault();
                this.pickupDismissedCode = null;
                input.value = (pickup.kind === 'link' || pickup.kind === 'word-link')
                    ? pickup.href
                    : (pickup.kind === 'word' || pickup.kind === 'rtc')
                        ? pickup.code
                        : ShareCode.groupCode(pickup.code);
                this.handleSearchInput(input);
            });
            const settleDrag = () => {
                window.removeEventListener('pointerup', settleDrag); window.removeEventListener('pointercancel', settleDrag);
                if (!this.pasteUserResized) return;
                if (input.getBoundingClientRect().height > (parseFloat(getComputedStyle(input).minHeight) || 0) + 1) return;
                this.pasteUserResized = false; input.style.height = ''; this.autoGrowPasteInput();
            };
            input.addEventListener('pointerdown', event => {
                if (!this.pasteMode) return;
                const rect = event.currentTarget.getBoundingClientRect();
                if (event.clientX > rect.right - 18 && event.clientY > rect.bottom - 18) {
                    this.pasteUserResized = true; window.addEventListener('pointerup', settleDrag); window.addEventListener('pointercancel', settleDrag);
                }
            });
            $('#helpBtn').onclick = () => this.showHelp();
            $('#captionShareText').onclick = () => {
                const input = $('#searchInput');
                const text = input.value.trim().replace(/^[>》]\s*/, '');
                input.value = '> ' + text;
                input.focus();
                input.setSelectionRange(input.value.length, input.value.length);
                this.handleSearchInput(input);
                this.autoGrowPasteInput();
            };
            $('#captionShareFile').onclick = () => {
                const input = $('#searchInput');
                input.value = '》';
                input.focus();
                input.setSelectionRange(1, 1);
                this.handleSearchInput(input);
                $('#transferFileInput').click();
            };
            $('#captionPickup').onclick = () => {
                const input = $('#searchInput');
                input.focus();
                input.select();
            };
            $('#transferFileInput').onchange = async event => {
                const file = event.target.files && event.target.files[0];
                event.target.value = '';
                if (file) {
                    const input = $('#searchInput');
                    if (input && this.isFileShareTrigger((input.value || '')[0])) {
                        input.value = '';
                        this.handleSearchInput(input);
                    }
                    await this.shareFile(file);
                }
            };
            $('#layoutBtn').onclick = () => this.toggleEditLayout();
            this.syncFooterEntries();
            document.addEventListener('keydown', event => {
                if (event.key !== 'Escape' || !this.editLayout || $('.ui-dialog-overlay')) return;
                event.preventDefault(); this.cancelEditSession();
            });
            window.addEventListener('resize', () => this.closeLocalSelects());
            $('#modalBackdrop').onclick = () => this.closeAdmin();
            $('#cancelBtn').onclick = async () => {
                if ((await this.closeAdmin()) && this.adminPage) location.href = '/';
            };
            $('#saveBtn').onclick = () => this.save();
            $('#modal .modal-content').addEventListener('keydown', event => {
                if (event.key !== 'Tab' || $('#modal').hidden || $('.ui-dialog-overlay')) return;
                const items = [...$('#modal .modal-content').querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href]')].filter(el => el.getClientRects().length);
                if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items.at(-1)?.focus(); }
                if (!event.shiftKey && document.activeElement === items.at(-1)) { event.preventDefault(); items[0]?.focus(); }
            });
            const engineBtn = $('#engineBtn'), dropdown = $('#engineDropdown');
            engineBtn.onclick = event => {
                event.stopPropagation();
                const rect = engineBtn.getBoundingClientRect();
                const wrapperRect = dropdown.parentElement.getBoundingClientRect();
                const width = Math.min(rect.width, window.innerWidth - 24);
                dropdown.style.width = `${width}px`;
                dropdown.style.left = `${rect.left - wrapperRect.left}px`;
                dropdown.hidden = !dropdown.hidden;
                engineBtn.setAttribute('aria-expanded', String(!dropdown.hidden));
                if (!dropdown.hidden) dropdown.querySelector('.engine-option.active')?.focus();
            };
            dropdown.onclick = event => {
                const option = event.target.closest('.engine-option');
                if (!option) return;
                this.config.searchEngine = option.dataset.id;
                this.saveLocalNavigation();
                this.renderEngines(); dropdown.hidden = true; engineBtn.setAttribute('aria-expanded', 'false'); input.focus();
            };
            document.onclick = event => {
                if (!event.target.closest('.search-wrapper')) { dropdown.hidden = true; engineBtn.setAttribute('aria-expanded', 'false'); }
            };
            document.onkeydown = event => {
                if (event.key !== 'Escape') return;
                if (!dropdown.hidden) { dropdown.hidden = true; engineBtn.setAttribute('aria-expanded', 'false'); engineBtn.focus(); }
                else if (!$('#modal').hidden) {
                    this.closeAdmin().then(closed => { if (closed && this.adminPage) location.href = '/'; });
                }
                else if (this.pasteMode) this.exitPasteMode();
                else {
                    const pickup = this.resolvePickup(input.value);
                    if (pickup.pickup) {
                        this.pickupDismissedCode = pickup.pickup.key;
                        this.syncSearchSubmitLabel(false, this.isFileShareTrigger((input.value || '')[0]));
                    }
                }
            };
        }

        bindKeyboardViewport() {
            const viewport = window.visualViewport;
            if (!viewport) return;
            let frame = 0;
            const sync = () => {
                if (frame) return;
                frame = requestAnimationFrame(() => {
                    frame = 0;
                    const covered = Math.max(0, Math.round(window.innerHeight - viewport.height - viewport.offsetTop));
                    document.documentElement.style.setProperty('--kb-inset', `${covered}px`);
                    // 编辑区的 max-height 依赖这个变量，键盘弹出/收起后要重新算高度，
                    // 否则会停在键盘弹出前算出的值上
                    this.autoGrowPasteInput();
                });
            };
            viewport.addEventListener('resize', sync);
            viewport.addEventListener('scroll', sync);
            sync();
        }

        bindPointerEffects() {
            if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;
            let frame = 0;
            const setPosition = (element, event, xName, yName) => {
                const rect = element.getBoundingClientRect();
                element.style.setProperty(xName, `${event.clientX - rect.left}px`);
                element.style.setProperty(yName, `${event.clientY - rect.top}px`);
            };
            $('#searchForm').addEventListener('pointermove', event => {
                if (frame) return;
                frame = requestAnimationFrame(() => {
                    setPosition($('#searchForm'), event, '--glow-x', '--glow-y');
                    const control = event.target.closest('.search-mode,.search-engine,.search-btn');
                    if (control) setPosition(control, event, '--glow-x', '--glow-y');
                    frame = 0;
                });
            });
            let gridFrame = 0;
            $('#grid').addEventListener('pointermove', event => {
                const bookmark = event.target.closest('.bookmark');
                if (!bookmark || gridFrame) return;
                gridFrame = requestAnimationFrame(() => {
                    setPosition(bookmark, event, '--glow-x', '--glow-y');
                    gridFrame = 0;
                });
            });
        }

        bindBookmarkPress(host) {
            const grid = host || this.surfaceOf().host;
            const releaseTimers = new WeakMap();
            let pressedBookmark = null;
            const press = (bookmark) => {
                clearTimeout(releaseTimers.get(bookmark));
                bookmark.classList.add('is-pressed');
            };
            const release = (bookmark) => {
                if (!bookmark) return;
                clearTimeout(releaseTimers.get(bookmark));
                releaseTimers.set(bookmark, setTimeout(() => bookmark.classList.remove('is-pressed'), 135));
            };
            grid.addEventListener('pointerdown', (event) => {
                if (event.button !== 0) return;
                if (pressedBookmark) pressedBookmark.classList.remove('is-pressed');
                pressedBookmark = event.target.closest('.bookmark');
                if (pressedBookmark) press(pressedBookmark);
            });
            grid.addEventListener('pointerout', (event) => {
                if (event.pointerType === 'touch' || !pressedBookmark) return;
                if (pressedBookmark.contains(event.target) && !pressedBookmark.contains(event.relatedTarget)) {
                    pressedBookmark.classList.remove('is-pressed');
                    pressedBookmark = null;
                }
            });
            window.addEventListener('pointerup', () => {
                release(pressedBookmark);
                pressedBookmark = null;
            });
            window.addEventListener('pointercancel', () => {
                pressedBookmark?.classList.remove('is-pressed');
                pressedBookmark = null;
            });
            grid.addEventListener('click', (event) => {
                const bookmark = event.target.closest('.bookmark');
                if (!bookmark) return;
                press(bookmark);
                release(bookmark);
            });
        }

        moveBookmark(fromCat, fromBm, toCat, toBm, surface = this.homeSurface) {
            surface = this.surfaceOf(surface);
            const cats = surface.getConfig().categories;
            const [item] = cats[fromCat].bookmarks.splice(fromBm, 1);
            if (fromCat === toCat && fromBm < toBm) toBm--;
            cats[toCat].bookmarks.splice(toBm, 0, item);
            this.renderGrid(surface);
            surface.changed();
        }

        moveCategory(from, to, surface = this.homeSurface) {
            surface = this.surfaceOf(surface);
            const cats = surface.getConfig().categories;
            const [item] = cats.splice(from, 1);
            cats.splice(to, 0, item);
            this.renderGrid(surface);
            surface.changed();
        }

        // ========== 首页编辑模式（书签 / 分类的增删改与拖拽） ==========
        //
        // 拖拽走 HTML5 DnD 而非 pointer 事件：模块那边用 pointer 是因为宽屏
        // 绝对定位卡片要实时跟手并自己处理基准跳变，而书签网格是 CSS grid、
        // 没有 --stack-top 那一层补偿。一次拖拽开始后浏览器会抑制随后的
        // click（规范行为），所以同一张卡既能拖又能点开编辑框，
        // 不需要额外的计时器去区分。

        bindGridEdit(surface = this.homeSurface) {
            surface = this.surfaceOf(surface);
            const grid = surface.host;
            if (!grid) return;
            let dragFrom = null;
            let dragKind = null;
            // pointerdown 落在哪个区域，比 dragstart.target 更可靠：
            // 分类的宿主是 .category-header，而书签是 section 内部的 <a>，
            // 两者在 dragstart.target 上无法区分（都解析到最近的 draggable）。
            // 按下时记下真实落点，dragstart 只用它定性。
            // ⚠️ 判据是「落在分类头里」，而**不是**「落在 ⠿ 上」——
            // 宿主已经是分类头，把手只是它内部的一个点。
            let downOnCategory = false;

            const catIndexOf = node => {
                const section = node.closest('.category');
                return section ? +section.dataset.cat : -1;
            };
            const bmIndexOf = node => {
                const card = node.closest('.bookmark');
                return card && card.dataset.bm !== undefined ? +card.dataset.bm : -1;
            };

            grid.addEventListener('pointerdown', event => {
                if (!surface.isEditing() || event.button !== 0) return;
                // ⚠️ 落在 ✎/✕ 上必须取消这次按压，否则会连累按钮。
                // 分类头整块 draggable，而**后代的 draggable="false" 并不能豁免**：
                // 实测 Chrome 里可拖拽祖先的后代（普通 button、写死 draggable=false 的
                // button、h2 都一样）按下照样起拖，dragstart 命中祖先。
                // 于是按住 ✎ 横拖 = 拖走整个分类，浏览器按规范抑制随后的 click，
                // 重命名/删除对话框再也打不开（实测：单独点击正常，一拖就死）。
                // pointerdown 里 preventDefault 能彻底取消起拖——对照页实测
                // 取消后一个 dragstart 都不发，只有 click 照常送达。
                // dragstart 里再 preventDefault 就晚了：拖影已经出现、click 已丢。
                if (event.target.closest('.category-action:not(.category-drag)')) {
                    event.preventDefault();
                    downOnCategory = false;
                    return;
                }
                downOnCategory = !!event.target.closest('.category-header');
            });

            grid.addEventListener('dragstart', event => {
                if (!surface.isEditing()) return;
                if (downOnCategory) {
                    dragKind = 'cat';
                    dragFrom = catIndexOf(event.target);
                    // .category.is-dragging 的样式早已存在（压暗整块），
                    // 但此前没有任何代码给分类加过这个 class——空规则。
                    // 注意它挂在整个 <section> 上，所以拖一个分类会把它下面
                    // 所有书签卡一起压暗 45%，不是只压暗把手。
                    const source = event.target.closest('.category');
                    if (source) source.classList.add('is-dragging');
                    event.dataTransfer.effectAllowed = 'move';
                    event.dataTransfer.setData('text/plain', String(dragFrom));
                    return;
                }
                const card = event.target.closest('.bookmark');
                // 加号卡不参与排序，它是「新增」入口
                if (!card || card.classList.contains('bookmark-add')) {
                    // 既不是分类头也不是书签卡（例如从 ＋ 卡片起拖）：
                    // 明确取消这次拖拽。什么都不做的话浏览器会照常画拖影，
                    // 松手也没 drop——用户看到的是「能拖、拖了没反应」。
                    event.preventDefault();
                    dragKind = null;
                    return;
                }
                dragKind = 'bm';
                dragFrom = { cat: catIndexOf(card), bm: bmIndexOf(card) };
                card.classList.add('is-dragging');
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('text/plain', card.dataset.bm);
            });

            grid.addEventListener('dragover', event => {
                if (!surface.isEditing() || !dragKind) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
                if (dragKind !== 'cat') return;
                // 分类拖拽的落点提示：拖到谁头上，谁就压暗。
                // 书签拖拽靠 .is-dragging 半透明表达（卡片多、逐个高亮反而吵）。
                const section = event.target.closest('.category');
                $$('.category.drop-target', grid).forEach(n => n.classList.remove('drop-target'));
                if (section && +section.dataset.cat !== dragFrom) {
                    section.classList.add('drop-target');
                }
            });

            grid.addEventListener('drop', event => {
                if (!surface.isEditing() || !dragKind) return;
                event.preventDefault();
                if (dragKind === 'cat') {
                    const to = catIndexOf(event.target);
                    // 落在自己身上不算移动，必须严格不同才搬
                    if (to >= 0 && to !== dragFrom) this.moveCategory(dragFrom, to, surface);
                    $$('.category.drop-target', grid).forEach(n => n.classList.remove('drop-target'));
                } else {
                    const section = event.target.closest('.category');
                    const targetBm = event.target.closest('.bookmark');
                    const toCat = section ? +section.dataset.cat : -1;
                    // 守卫必须在**解引用之前**。「＋ 添加分类」按钮与网格间隙
                    // 都在任一 .category 之外，closest 返回 null → toCat = -1，
                    // 而 categories[-1] 是 undefined。原写法把 if (toCat >= 0)
                    // 放在求值之后，异常从监听器抛出，dragKind 的清理
                    // （下面两行）不执行——拖拽状态就此卡住，下一次
                    // dragover 仍认为在拖拽。
                    if (toCat < 0) { dragKind = null; dragFrom = null; return; }
                    // 落在空白书签区（没有具体书签）时追加到该分类末尾
                    const toBm = targetBm && !targetBm.classList.contains('bookmark-add')
                        ? +targetBm.dataset.bm
                        : surface.getConfig().categories[toCat].bookmarks.length;
                    if (toBm >= 0) this.moveBookmark(dragFrom.cat, dragFrom.bm, toCat, toBm, surface);
                }
                dragKind = null;
                dragFrom = null;
            });

            grid.addEventListener('dragend', () => {
                $$('.bookmark.is-dragging', grid).forEach(n => n.classList.remove('is-dragging'));
                $$('.category.is-dragging', grid).forEach(n => n.classList.remove('is-dragging'));
                // ⚠️ 落点高亮必须在这里也清一遍。drop 只在**松手点位于 #grid 内**
                // 才触发，而监听挂在 grid 上——拖到页头、模块区、留白处松手
                // 走不到 drop 的清理，落点分类就一直压暗着，而它的视觉与
                // .is-dragging 完全相同（同为 opacity .55），用户分不清
                // 「在拖」还是「卡住了」。
                $$('.category.drop-target', grid).forEach(n => n.classList.remove('drop-target'));
                dragKind = null;
                dragFrom = null;
                downOnCategory = false;
            });

            grid.addEventListener('click', event => {
                if (!surface.isEditing()) return;
                const target = event.target;

                const addCard = target.closest('.bookmark-add');
                if (addCard) { event.preventDefault(); this.addHomeBookmark(+addCard.dataset.addCat, surface); return; }

                if (target.closest('.category-add')) { event.preventDefault(); this.addHomeCategory(surface); return; }

                const delCat = target.closest('.category-del');
                if (delCat) { event.preventDefault(); this.deleteHomeCategory(+delCat.dataset.delCat, surface); return; }

                const editCat = target.closest('.category-edit');
                if (editCat) { event.preventDefault(); this.renameHomeCategory(+editCat.dataset.editCat, surface); return; }

                // 删除按钮优先于卡片本身：它压在卡右上角，
                // 若继续往下走会当成「点卡片」而打开编辑框。
                const delBm = target.closest('.bookmark-del');
                if (delBm) {
                    event.preventDefault();
                    event.stopPropagation();
                    this.deleteHomeBookmark(catIndexOf(delBm), +delBm.dataset.delBm, surface);
                    return;
                }

                const card = target.closest('.bookmark');
                if (card) {
                    // 编辑态下书签卡不再是链接入口，点了是打开编辑框
                    event.preventDefault();
                    this.editHomeBookmark(catIndexOf(card), bmIndexOf(card), surface);
                }
            });

            // 编辑态下书签卡整体是拖拽宿主，按下即进入原生拖拽。
            // 链接默认导航由下面的 click 分支拦（编辑态点了是打开编辑框，不是跳转）。
            grid.addEventListener('pointerdown', event => {
                if (!surface.isEditing() || event.button !== 0) return;
                const card = event.target.closest('.bookmark');
                if (!card || card.classList.contains('bookmark-add')) return;
                card.focus();
            });

            this.bindTouchGridDrag(surface);
        }

        /**
         * 触摸端的长按拖拽（书签 / 分类）。
         *
         * 为什么不能靠原生 DnD：MDN 写明 drag events **继承自 mouse events**
         * （"drag events inherited from mouse events"），而触摸没有 mouse 事件链，
         * 所以 iOS Safari / Android Chrome 上按了也不发 dragstart——实测层级的
         * 事实，不是兼容性不足。CSS 的 touch-action 管不了这个，它只决定浏览器
         * 是否接管手势。模块卡片那边不受影响是因为它走的是 pointer 事件。
         *
         * 所以触摸端单独一条 pointer 路径，与模块拖拽同一套机制
         * （pointer capture + window 上的终止监听），排序则复用桌面端
         * 同一个 moveCategory / moveBookmark——两套排序实现就会有两个真值。
         *
         * 激活判据是**长按 400ms、容忍 25px 漂移**（iOS 长按菜单与
         * @dragdroptouch 的 pressHoldDelayMS / pressHoldMargin 同量级）。
         * 不用「一按就拖」：书签网格在首页常常要滚动浏览，抢走手势就没法滚了；
         * 也不用纯位移阈值：滑动页面途中就判成拖拽，误触成本高。
         * ⚠️ 因此**不写 touch-action: none**。
         *
         * 落点用 elementFromPoint 判定，而不是坐标几何：网格会随拖拽重排，
         * 实时几何与缓存中线都可能失效（模块那条路径踩过这个坑，
         * 见 reorderWhileDragging 的注释）。
         */
        bindTouchGridDrag(surface = this.homeSurface) {
            surface = this.surfaceOf(surface);
            const grid = surface.host;
            if (!grid) return;
            const HOLD_MS = 400;
            const HOLD_TOLERANCE = 25;
            // 激活后的拖拽状态；未激活时 hold 为 null
            let hold = null;
            let drag = null;

            const catIndexOf = node => {
                const section = node.closest('.category');
                return section ? +section.dataset.cat : -1;
            };

            const clearHold = () => {
                if (!hold) return;
                clearTimeout(hold.timer);
                hold.node.classList.remove('is-arming');
                hold = null;
            };

            // 按落点算出「分类 / 书签」的哪一条，统一返回 {kind, cat, bm, node}
            const resolveTarget = (x, y) => {
                const el = document.elementFromPoint(x, y);
                if (!el) return null;
                const add = el.closest('.bookmark-add, .category-add');
                // ＋ 卡片是新增入口，不参与排序
                if (add) return null;
                const card = el.closest('.bookmark');
                const section = el.closest('.category');
                const toCat = section ? +section.dataset.cat : -1;
                if (toCat < 0) return null;
                const toBm = card && card.dataset.bm !== undefined
                    ? +card.dataset.bm
                    : surface.getConfig().categories[toCat].bookmarks.length;
                return { card: !!card, cat: toCat, bm: toBm, section };
            };

            grid.addEventListener('pointerdown', event => {
                // 只接触摸。鼠标走已验证的原生 DnD，两条路径**互不重叠**：
                // 桌面端若也进这条路径，就要额外处理「一按就拖 vs 选文字」。
                if (event.pointerType !== 'touch' || event.button !== 0) return;
                if (!surface.isEditing()) return;
                // ✎/✕ 上按下不拖（同 pointerdown 的排除，见 bindGridEdit）
                if (event.target.closest('.category-action:not(.category-drag)')) return;

                const header = event.target.closest('.category-header');
                const card = event.target.closest('.bookmark');
                const node = header || (card && !card.classList.contains('bookmark-add') ? card : null);
                if (!node) return;

                const source = {
                    node,
                    kind: header ? 'cat' : 'bm',
                    from: header
                        ? catIndexOf(header)
                        : { cat: catIndexOf(card), bm: +card.dataset.bm }
                };
                clearHold();
                hold = {
                    ...source,
                    // pointerId 必须存下来：settle 用它判断「这次松手是不是
                    // 这一根手指」。早先没存，settle 里 `hold.pointerId` 恒为
                    // undefined，与任何 pointerId 都不相等——于是那一道守卫
                    // 只能靠 `!event` 兜底，pointercancel 路径上 hold 清不掉。
                    pointerId: event.pointerId,
                    x: event.clientX,
                    y: event.clientY,
                    timer: setTimeout(() => activate(event.pointerId), HOLD_MS)
                };
                node.classList.add('is-arming');

                function activate(pointerId) {
                    if (!hold) return;
                    const { node: n, kind, from } = hold;
                    clearHold();
                    // ⚠️ 「压暗谁」必须与「复原谁」是同一个元素。分类拖拽压暗的是
                    // **整块 section**（CSS 就是 .category.is-dragging），
                    // 而收尾时若按 node（分类头）去 remove，section 上那层永远清不掉——
                    // 只要这次拖拽没提交（取消、落点无效），压暗就会一直留着。
                    // 所以把承载 class 的元素记进 drag，两边都读它。
                    const tinted = kind === 'cat' ? (n.closest('.category') || n) : n;
                    drag = { id: pointerId, node: n, tinted, kind, from, to: null };
                    tinted.classList.add('is-dragging');
                    // 拖拽期间接管后续手势，并阻止滚动/缩放被浏览器抢走。
                    // touch-action 在 CSS 里**不能**这么写（会把滚动永久禁掉），
                    // 只能在激活这一刻取消。
                    try { n.setPointerCapture(pointerId); } catch (e) {}
                    // 长按激活后必须压掉随后的 click，否则松手会顺带打开编辑框。
                    // 桌面端靠 DnD 规范自动抑制 click，触摸端没有这个保证。
                    suppressNextClick(n);
                }
            });

            const move = event => {
                if (hold) {
                    // 长按期间的漂移超过容忍 = 用户在滚动，不是想拖
                    const dx = event.clientX - hold.x;
                    const dy = event.clientY - hold.y;
                    if (Math.hypot(dx, dy) > HOLD_TOLERANCE) {
                        clearHold();
                        return;
                    }
                    return;
                }
                if (!drag || event.pointerId !== drag.id) return;
                event.preventDefault();
                const target = resolveTarget(event.clientX, event.clientY);
                if (!target) {
                    $$('.category.drop-target', grid).forEach(n => n.classList.remove('drop-target'));
                    drag.to = null;
                    return;
                }
                drag.to = target;
                // 分类拖拽给出落点提示；书签拖拽靠 .is-dragging 半透明表达
                $$('.category.drop-target', grid).forEach(n => n.classList.remove('drop-target'));
                if (drag.kind === 'cat' && target.section && target.cat !== drag.from) {
                    target.section.classList.add('drop-target');
                }
            };

            const settle = event => {
                if (hold && (!event || event.pointerId === hold.pointerId)) clearHold();
                if (!drag || (event && event.pointerId !== drag.id)) return;
                const { node, tinted, kind, from, to, id } = drag;
                drag = null;
                try { node.releasePointerCapture(id); } catch (e) {}
                tinted.classList.remove('is-dragging');
                $$('.category.drop-target', grid).forEach(n => n.classList.remove('drop-target'));
                // to 只在 move 里被设过。长按满 400ms 却一直没动时它是 null——
                // 不看这一条，松手就会把元素挪到一个用户没指过的地方。
                // （一个曾经存在的 `moved` 标志被删掉了：它与 `!to` 等价，
                //   变异验证显示删掉它没有任何用例转红，即它是死代码。）
                if (!to) return;
                if (kind === 'cat') {
                    if (to.cat !== from) this.moveCategory(from, to.cat, surface);
                } else if (to.cat !== from.cat || to.bm !== from.bm) {
                    this.moveBookmark(from.cat, from.bm, to.cat, to.bm, surface);
                }
            };

            window.addEventListener('pointermove', move);
            window.addEventListener('pointerup', settle);
            window.addEventListener('pointercancel', settle);

            // 激活后抑制一次 click：长按松手会顺带触发 click，
            // 而 click 分支会打开编辑框 / 新建对话框——用户只想挪个位置。
            function suppressNextClick(node) {
                const swallow = event => {
                    if (!(node === event.target || node.contains(event.target))) return;
                    event.stopPropagation();
                    event.preventDefault();
                };
                grid.addEventListener('click', swallow, { capture: true, once: true });
                // 万一这次没有 click（例如手指在激活后滑走），兜底移除，
                // 否则监听会一直留着，下一次真实点击被吞掉。
                setTimeout(() => grid.removeEventListener('click', swallow, true), 600);
            }
        }

        /** 书签字段校验：标题非空、URL 必须是 http/https。 */
        bookmarkFieldError([title, url, iconUrl = '']) {
            if (!title || !title.trim()) return '请填写标题';
            const trimmed = (url || '').trim();
            if (!trimmed) return '请填写网址';
            let parsed;
            try { parsed = new URL(trimmed); } catch (e) { return '网址格式不正确'; }
            if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '网址必须以 http:// 或 https:// 开头';
            if (iconUrl.trim()) {
                if (iconUrl.trim().length > 2048) return '图标地址不能超过 2048 个字符';
                try { parsed = new URL(iconUrl.trim()); } catch { return '图标地址格式不正确'; }
                if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || iconUrl.trim().includes('#')) return '图标地址必须使用无凭据且不含片段的 HTTP/HTTPS 地址';
            }
            return '';
        }

        async addHomeBookmark(catIdx, surface = this.homeSurface) {
            surface = this.surfaceOf(surface);
            const cat = surface.getConfig().categories[catIdx];
            if (!cat) return;
            const result = await this.showUiDialog({
                title: `为「${cat.name}」添加导航`,
                fields: [{ label: '标题' }, { label: '网址', placeholder: 'https://' }, { label: '自定义图标地址（可选）', placeholder: 'https://' }],
                confirmText: '添加',
                validate: (values, choices) => this.bookmarkFieldError(values)
            });
            if (!result) return;
            const [title, url, iconUrl] = result.values;
            cat.bookmarks.push({ id: uid(), title: title.trim(), url: url.trim(), ...(iconUrl.trim() ? { iconUrl: iconUrl.trim() } : {}) });
            this.renderGrid(surface);
            surface.changed();
            // 提示语要指向真正能提交这次改动的那颗按钮。
            if (surface === this.siteSurface) this.showToast('导航已添加，点右上角「保存并发布」生效');
            else this.showToast('导航已添加，回到编辑栏点「保存配置」生效');
        }

        async editHomeBookmark(catIdx, bmIdx, surface = this.homeSurface) {
            surface = this.surfaceOf(surface);
            const bm = surface.getConfig().categories[catIdx]?.bookmarks[bmIdx];
            if (!bm) return;
            const result = await this.showUiDialog({
                title: '编辑导航',
                message: `所属分类：${surface.getConfig().categories[catIdx].name}`,
                fields: [{ label: '标题', value: bm.title }, { label: '网址', value: bm.url }, { label: '自定义图标地址（可选）', value: bm.iconUrl || '', placeholder: '留空时自动获取' }],
                options: [{ kind: 'checkbox', name: 'refreshIcon', value: 'true', label: '保存并刷新图标' }],
                confirmText: '保存',
                validate: values => this.bookmarkFieldError(values)
            });
            if (!result) return;
            const [title, url, iconUrl] = result.values;
            bm.title = title.trim();
            bm.url = url.trim();
            if (iconUrl.trim()) bm.iconUrl = iconUrl.trim(); else delete bm.iconUrl;
            surface.changed();
            if (result.choices.refreshIcon) {
                const message = await this.refreshBookmarkIcon(bm);
                if (message) this.showToast(message, 'error');
                else { this.showToast('图标已刷新'); this.renderGrid(surface); }
                if (message) {
                    const card = [...surface.host.querySelectorAll('.bookmark[data-cat][data-bm]')].find(node => +node.dataset.cat === catIdx && +node.dataset.bm === bmIdx);
                    if (card) {
                        card.href = bm.url;
                        card.title = bm.title;
                        card.querySelector('.bookmark-title').textContent = bm.title;
                        const remove = card.querySelector('.bookmark-del');
                        if (remove) { remove.title = `删除导航 ${bm.title}`; remove.setAttribute('aria-label', `删除导航 ${bm.title}`); }
                    }
                }
            } else {
                this.renderGrid(surface);
            }
        }

        async deleteHomeBookmark(catIdx, bmIdx, surface = this.homeSurface) {
            surface = this.surfaceOf(surface);
            const bm = surface.getConfig().categories[catIdx]?.bookmarks[bmIdx];
            if (!bm) return;
            if (!await this.confirmAction(`删除导航「${bm.title}」？`, '删除导航', true)) return;
            surface.getConfig().categories[catIdx].bookmarks.splice(bmIdx, 1);
            this.renderGrid(surface);
            surface.changed();
        }

        async addHomeCategory(surface = this.homeSurface) {
            surface = this.surfaceOf(surface);
            const name = await this.promptValue('添加分类', '分类名称', { validate: ([v]) => (v && v.trim()) ? '' : '请填写分类名称' });
            if (name === null) return;
            surface.getConfig().categories.push({ id: uid(), name: name.trim(), bookmarks: [] });
            this.renderGrid(surface);
            surface.changed();
        }

        async renameHomeCategory(catIdx, surface = this.homeSurface) {
            surface = this.surfaceOf(surface);
            const cat = surface.getConfig().categories[catIdx];
            if (!cat) return;
            const name = await this.promptValue('重命名分类', '分类名称', {
                value: cat.name,
                validate: ([v]) => (v && v.trim()) ? '' : '请填写分类名称'
            });
            if (name === null) return;
            cat.name = name.trim();
            this.renderGrid(surface);
            surface.changed();
        }

        async deleteHomeCategory(catIdx, surface = this.homeSurface) {
            surface = this.surfaceOf(surface);
            // 至少留一个分类：首页要有一个容器，否则网格整块空掉
            if (surface.getConfig().categories.length <= 1) {
                this.showToast('至少保留一个分类', 'error');
                return;
            }
            const cat = surface.getConfig().categories[catIdx];
            if (!cat) return;
            const message = cat.bookmarks.length
                ? `删除分类「${cat.name}」及其中的 ${cat.bookmarks.length} 个导航？`
                : `删除分类「${cat.name}」？`;
            if (!await this.confirmAction(message, '删除分类', true)) return;
            surface.getConfig().categories.splice(catIdx, 1);
            this.renderGrid(surface);
            surface.changed();
        }

        search() {
            const q = $('#searchInput').value.trim();
            if (!q) return;
            const engine = this.config.searchEngines.find(e => e.id === this.config.searchEngine);
            if (engine) window.open(engine.url + encodeURIComponent(q), '_blank');
            $('#searchInput').value = '';
        }

        // ========== 书签模糊检索 ==========

        notifyIdentityChanged() {
            this.authChannel?.postMessage('changed');
            try { localStorage.setItem('pabu-auth-reset', String(Date.now())); } catch {}
        }

        hasAdministratorDraft() {
            return this.configDirty || this.navigationSaving || !!this.pendingNavigation || !!$('.ui-dialog-overlay');
        }

        async checkAdministratorSync() {
            if (this.administratorChecking) return;
            this.administratorChecking = true;
            try {
                const session = await this.loadSession();
                if (!session.authenticated) {
                    if (this.authenticated) await this.expirePrivateState();
                    return;
                }
                if (!this.authenticated) { await this.restoreSession(); return; }
                if (!this.siteLoaded || !this.authenticated) return;
                const navigation = await API.get('/api/admin/navigation');
                if (!this.authenticated) return;
                if (navigation.revision !== this.navigationRevision) {
                    if (this.hasAdministratorDraft()) {
                        this.showToast('站点导航已被其他管理员更新，当前草稿已保留', 'error', 8000);
                        return;
                    }
                    this.siteConfig = structuredClone(navigation.config);
                    this.navigationRevision = navigation.revision;
                    this.configSnapshot = JSON.stringify(this.siteConfig);
                    this.configDirty = false;
                    if (this.siteSurface) this.renderSiteEditor();
                }
            } catch (e) {
                if (this.authenticated) this.showToast('暂时无法同步，联网后重试', 'error');
            } finally { this.administratorChecking = false; }
        }

        resetSiteEditorState(keepDraft = null) {
            this.siteLoaded = false;
            this.siteConfig = null;
            this.siteSurface = null;
            this.suspendedSiteDraft = keepDraft;
            this.configDirty = false;
            this.configSnapshot = null;
            this.pendingNavigation = null;
        }

        async expirePrivateState() {
            if (!this.authenticated) return;
            const keep = this.siteDirty() ? {
                config: structuredClone(this.siteConfig),
                revision: this.navigationRevision,
                snapshot: this.configSnapshot,
                pending: this.pendingNavigation
            } : null;
            this.authenticated = false;
            this.sessionTrusted = false;
            this.privateEpoch = (this.privateEpoch || 0) + 1;
            this.resetSiteEditorState(keep);
            this.applyTheme();
            $('#modal').hidden = true;
            if (this.adminPage) {
                const login = await this.showUiDialog({ title: '登录已失效', message: keep ? '站点导航草稿仅保留在当前标签页，重新登录后继续编辑。' : '请重新登录管理后台。', confirmText: '重新登录', cancelText: '关闭' });
                if (login) await this.openAdmin();
                else { this.suspendedSiteDraft = null; location.href = '/'; }
            } else {
                this.showToast('管理员登录已失效', 'error');
            }
        }

        clearPrivateState() {
            this.authenticated = false;
            this.sessionTrusted = false;
            this.privateEpoch = (this.privateEpoch || 0) + 1;
            this.resetSiteEditorState();
            this.applyTheme();
            this.navigationSaving = false;
            this.configSaving = false;
            sessionStorage.removeItem('pabu-pending-site');
            $('#modal').hidden = true;
            $('.admin-panels')?.replaceChildren(); $$('.ui-dialog-overlay').forEach(el => el.remove());
        }

        async loadSession() {
            return API.get('/api/session');
        }

        // 管理员会话只影响 /admin 的可用性，不改变首页本地导航。
        async restoreSession() {
            this.identityPending = true;
            try {
                const session = await (this.initialSession || this.loadSession());
                this.initialSession = null;
                if (session.authenticated) {
                    this.authenticated = true;
                    this.sessionTrusted = !!session.trusted;
                } else if (this.authenticated) {
                    this.clearPrivateState();
                }
                return !!session.authenticated;
            } catch (e) {
                console.error('Restore session failed:', e);
                this.setLocalStatus('无法确认管理员登录，本地导航仍可使用，网络恢复后重新确认', true);
                return false;
            } finally {
                this.identityPending = false;
                this.sessionProbe = null;
            }
        }

        async waitForSession() {
            if (!this.sessionProbe) return;
            try { await this.sessionProbe; } catch (error) { console.warn('会话探测失败:', error.message); }
        }

        /**
         * 设置当前会话是否被信任。
         * @param {boolean} trusted true=30 天免重复登录，false=降回 24 小时（不登出）
         * @returns {Promise<boolean>} 是否设置成功
         */
        async setDeviceTrust(trusted) {
            try {
                const res = await API.post('/api/trust-device', { trusted });
                if (res.requiresLogin) {
                    // 服务端没有会话可调整（仅可能发生在仍用明文密码的旧页面上）。
                    // 不静默失败：那会让开关看起来生效了，实际没变。
                    this.showToast('未能设置，请重新登录后再试', 'error');
                    return false;
                }
                if (res.trusted !== undefined) this.sessionTrusted = !!res.trusted;
                return !!res.trusted;
            } catch (e) {
                console.error('Set device trust failed:', e);
                return false;
            }
        }

        async trustDevice() {
            return this.setDeviceTrust(true);
        }

        // 信任此设备开关下方的说明文字。写清「关闭」的实际后果，
        // 避免用户以为关掉就等于退出登录。
        updateTrustDeviceHint() {
            const hint = $('#trustDeviceHint');
            if (!hint) return;
            hint.textContent = this.sessionTrusted
                ? '30 天内免重复登录；关闭后当前会话仍有效，但 24 小时后需重新登录。'
                : '当前设备未被信任，24 小时后需重新登录。';
        }

        // 站点导航由管理员统一维护。读取时带上 revision，保存即发布。
        siteDirty() {
            return this.configSnapshot !== null && !!this.siteConfig
                && JSON.stringify(this.siteConfig) !== this.configSnapshot;
        }

        /** 读取站点默认导航。它只服务 /admin 的一比一画布，不碰首页本地导航。 */
        async loadSiteEditor() {
            const retry = sessionStorage.getItem('pabu-pending-site');
            if (retry) {
                const request = JSON.parse(retry);
                try {
                    const result = await API.post('/api/admin/navigation', request.body);
                    if (!result.success) throw new Error(result.error || '上次保存结果尚未确认');
                } catch (error) {
                    this.showToast('上次站点导航保存未确认：' + error.message, 'error', 8000);
                }
                sessionStorage.removeItem('pabu-pending-site');
            }

            if (this.suspendedSiteDraft) {
                const draft = this.suspendedSiteDraft;
                this.suspendedSiteDraft = null;
                this.siteConfig = draft.config;
                this.navigationRevision = draft.revision;
                this.pendingNavigation = draft.pending;
                this.siteLoaded = true;
                this.configSnapshot = draft.snapshot;
                this.configDirty = this.siteDirty();
                this.showToast('站点导航草稿已恢复');
                return;
            }

            const data = await API.get('/api/admin/navigation');
            if (!this.authenticated) throw new Error('登录状态已变化');
            this.siteConfig = structuredClone(data.config);
            this.navigationRevision = data.revision;
            this.pendingNavigation = null;
            this.siteLoaded = true;
            this.configSnapshot = JSON.stringify(this.siteConfig);
            this.configDirty = false;
        }

        mountSiteEditor() {
            const grid = $('#siteGrid');
            if (!grid || !this.siteConfig) return;
            this.siteSurface = this.gridSurface({
                getConfig: () => this.siteConfig,
                isEditing: () => true,
                host: grid,
                changed: () => this.markConfigDirty()
            });
            this.bindGridEdit(this.siteSurface);
            this.bindBookmarkPress(grid);
            this.renderSiteEditor();
        }

        renderSiteHeader() {
            const header = $('#siteHeader');
            if (!header || !this.siteConfig) return;
            const engine = this.siteConfig.searchEngines.find(e => e.id === this.siteConfig.searchEngine) || this.siteConfig.searchEngines[0];
            header.innerHTML = `<div class="search-wrapper"><div class="search" role="presentation">
                <span class="search-engine" aria-hidden="true"><span class="engine-name">${this.esc(engine ? engine.name : '')}</span><svg class="engine-arrow" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg></span>
                <textarea class="search-input" rows="1" readonly tabindex="-1" aria-hidden="true" placeholder="搜索网页"></textarea>
                <span class="search-btn" aria-hidden="true">搜索</span>
            </div></div>`;
        }

        applySitePreviewTheme() {
            if (!this.siteConfig) return;
            const appearance = window.NavigationSchema.appearance(this.siteConfig);
            const root = document.documentElement;
            root.dataset.themeStyle = appearance.style;
            if (appearance.mode === 'auto') root.removeAttribute('data-theme');
            else root.setAttribute('data-theme', appearance.mode);
        }

        renderSiteThemeSwitcher() {
            const host = $('#siteThemeSwitcher');
            if (!host || !this.siteConfig) return;
            this.renderThemeDropdown(host, {
                style: window.NavigationSchema.appearance(this.siteConfig).style,
                optionAttr: 'data-site-theme',
                onSelect: id => {
                    this.siteConfig.themeStyle = id;
                    this.applySitePreviewTheme();
                    this.renderSiteThemeSwitcher();
                    this.renderSiteControls();
                    this.markConfigDirty();
                }
            });
        }

        renderSiteEditor() {
            const grid = $('#siteGrid');
            if (!grid || !this.siteConfig || !this.siteSurface) return;
            this.applySitePreviewTheme();
            grid.classList.add('is-editing');
            this.renderSiteHeader();
            this.renderSiteThemeSwitcher();
            this.renderGrid(this.siteSurface);
            this.updateConfigStatus();
        }

        async saveSiteNavigation(options = {}) {
            if (!this.siteLoaded) throw new Error('站点导航未加载，请刷新后重试');
            const content = JSON.stringify(this.siteConfig);
            if (this.navigationSaving) throw new Error('正在保存，请稍后重试');
            if (!this.pendingNavigation || this.pendingNavigation.content !== content) {
                this.pendingNavigation = { content, body: { config: JSON.parse(content), revision: this.navigationRevision, operationId: crypto.randomUUID() } };
            }
            this.navigationSaving = true;
            this.updateConfigStatus('正在发布', 'pending');
            try {
                sessionStorage.setItem('pabu-pending-site', JSON.stringify({ body: this.pendingNavigation.body }));
                const res = await API.post('/api/admin/navigation', this.pendingNavigation.body, options);
                if (!res.success) {
                    if (res.error) { sessionStorage.removeItem('pabu-pending-site'); this.pendingNavigation = null; }
                    throw new Error(res.error || '保存结果尚未确认，请刷新后重试');
                }
                sessionStorage.removeItem('pabu-pending-site');
                this.navigationRevision = res.revision;
                this.configSnapshot = JSON.stringify(this.siteConfig);
                this.configDirty = false;
                this.pendingNavigation = null;
                this.updateConfigStatus('已发布', 'success');
                return res;
            } finally {
                this.navigationSaving = false;
            }
        }

        // 两个触发符分工：半角 > 进入文本分享，全角 》 交给文件选择。
        // 以前两者都进文本分享，输入法全角状态下想选文件会误开分享框。
        isTextShareTrigger(char) {
            return char === '>';
        }

        isFileShareTrigger(char) {
            return char === '》';
        }

        // 取件识别接受三种形状：文本 v2 的分组密钥/完整链接、文件一期的单词码，
        // 以及二期的 5 位实时配对码。单词码命中后由 /p/<code> 重定向到 /f/<code>；
        // 5 位码不跳转，直接在当前页打开接收对话框。
        parsePickup(text) {
            const raw = String(text ?? '').trim();
            if (!raw) return null;

            if (ShareCode.isRtcCode(raw)) return { kind: 'rtc', key: 'rtc:' + raw, code: raw };

            const link = /^https?:\/\/[^\s/]+\/p\/([a-z2-7]{26})(?:[/?#]([^\s]*))?$/i.exec(raw);
            if (link) {
                const id = link[1].toLowerCase();
                const hasKey = ShareCode.normalizeCode(link[2] || '').length === ShareCode.CODE_LENGTH;
                return { kind: 'link', key: (hasKey ? 'text:' : 'id:') + id, href: raw, id };
            }

            const fileLink = /^https?:\/\/[^\s/]+\/(?:p|f)\/([a-z]{2,6}-\d{3})\/?(?:[?#].*)?$/i.exec(raw);
            if (fileLink) {
                const code = fileLink[1].toLowerCase();
                return { kind: 'word-link', key: 'word:' + code, code, href: raw };
            }

            const word = /^[a-z]{2,6}-\d{3}$/i.exec(raw);
            if (word) {
                const code = word[0].toLowerCase();
                return { kind: 'word', key: 'word:' + code, code };
            }

            if (ShareCode.isCode(raw)) {
                const code = ShareCode.normalizeCode(raw);
                return { kind: 'key', key: 'key:' + code, code };
            }
            return null;
        }

        // 「识别到码」和「这次输入确实要取件」是两个问题：Esc 取消后前者仍成立。
        // 按钮文案与回车分发都从这里取值，避免各判一次而漂移。
        resolvePickup(value) {
            const pickup = this.parsePickup(value);
            return { pickup, active: !!pickup && pickup.key !== this.pickupDismissedCode };
        }

        // 普通搜索态的主按钮文案：取件、选文件、搜索三选一。
        // 分享态（发送）与书签态（打开）仍由各自的 toggle* 负责——同一个节点
        // 被多处写会互相覆盖，modeBtn 历史上正是这样坏过一次。
        syncSearchSubmitLabel(pickupActive, fileActive = false) {
            const searchBtn = $('.search-btn');
            if (!searchBtn) return;
            searchBtn.textContent = fileActive ? '选文件' : pickupActive ? '取件' : '搜索';
            searchBtn.title = fileActive
                ? '回车选择要分享的文件'
                : pickupActive ? '回车取回共享内容（Esc 改为搜索）' : '搜索';
        }

        // 接收 input 元素；也兼容直接传入事件对象
        handleSearchInput(event) {
            const input = event.target ?? event, value = input.value;
            if (!value.trim()) this.pickupDismissedCode = null;
            const paste = value.length > 0 && this.isTextShareTrigger(value[0]);
            if (paste !== this.pasteMode) { this.pasteMode = paste; this.togglePasteMode(paste); }
            if (!paste) {
                const file = value.length > 0 && this.isFileShareTrigger(value[0]);
                this.syncSearchSubmitLabel(this.resolvePickup(value).active, file);
            }
        }

        exitPasteMode() {
            const input = $('#searchInput');
            this.pasteMode = false;
            this.togglePasteMode(false);
            input.value = '';
            this.handleSearchInput(input);
            input.focus();
        }

        // textarea 只写 min-height 时高度会锁死，需按内容撑开。
        // 用户手动拖拽过的框不再自动跟随，否则会把刚拖出来的大小冲掉。
        autoGrowPasteInput() {
            const input = $('#searchInput');
            if (!this.pasteMode || this.pasteUserResized) return;
            // 先归零再量，否则上一次的 inline height 会成为新的测量基准
            input.style.height = 'auto';
            // clamp 到 CSS 的 max-height，避免把一个永远不生效的大值留在
            // inline 样式里（max-height:none 时 computed 会返回 "none"）
            const declared = parseFloat(getComputedStyle(input).maxHeight);
            const max = Number.isFinite(declared) ? declared : Infinity;
            input.style.height = `${Math.min(input.scrollHeight, max)}px`;
        }

        togglePasteMode(enabled) {
            const form = $('#searchForm');
            const input = $('#searchInput');
            const searchBtn = $('.search-btn');
            const engineBtn = $('#engineBtn');

            form.classList.toggle('paste-mode', enabled);

            // 搜索引擎按钮的显隐交给 CSS（.search.paste-mode #engineBtn），
            // 不用内联 display，否则无法参与过渡且会盖过样式表
            const dropdown = $('#engineDropdown');
            dropdown.hidden = true;
            engineBtn.setAttribute('aria-expanded', 'false');

            const modeBtn = $('#modeBtn');
            modeBtn.hidden = !enabled;
            modeBtn.textContent = '退出';
            modeBtn.setAttribute('aria-label', '退出文本分享');

            if (enabled) {
                input.placeholder = '输入要分享的文本，回车发送，Shift+回车换行...';
                // aria-label 优先于 placeholder 播报，不同步的话读屏用户会
                // 听到「搜索网页或书签」却在里面写分享文本
                input.setAttribute('aria-label', '要分享的文本');
                // 重置上次拖拽留下的大小，否则会以旧高度进入
                input.style.height = '';
                this.pasteUserResized = false;
                searchBtn.textContent = '发送';
                searchBtn.title = '发送分享';
            } else {
                input.placeholder = '搜索网页';
                input.setAttribute('aria-label', '搜索网页');
                input.style.height = '';
                this.pasteUserResized = false;
                searchBtn.textContent = '搜索';
                searchBtn.title = '搜索';
            }
        }

        async handleSearch() {
            const value = $('#searchInput').value;
            if (value.length && this.isFileShareTrigger(value[0])) {
                $('#transferFileInput').click();
                return;
            }
            if (value.length && this.isTextShareTrigger(value[0])) {
                const text = value.slice(1).trim();
                if (text) await this.showPasteOptions(text);
                return;
            }
            const pickup = this.resolvePickup(value);
            if (pickup.active) return this.openPickup(pickup.pickup);
            this.search();
        }

        async openPickup(pickup) {
            const dropdown = $('#engineDropdown');
            if (dropdown) dropdown.hidden = true;
            if (pickup.kind === 'rtc') {
                if (!window.RtcTransfer || !window.RtcTransfer.isSupported()) {
                    this.showToast('当前浏览器不支持实时传输，请通过 HTTPS 访问', 'error');
                    return;
                }
                await window.RtcTransfer.receive(pickup.code);
                return;
            }
            if (pickup.kind === 'link' || pickup.kind === 'word-link') {
                try {
                    const url = new URL(pickup.href);
                    if (url.origin !== location.origin) {
                        this.showToast('仅支持本站分享链接', 'error');
                        return;
                    }
                    // 文本链接统一成小写 ID，避免大小写差异把服务端路由判成无效。
                    if (pickup.kind === 'link') url.pathname = '/p/' + pickup.id;
                    location.assign(url.href);
                } catch {
                    this.showToast('分享链接无效', 'error');
                }
                return;
            }
            if (pickup.kind === 'word') {
                location.assign('/p/' + encodeURIComponent(pickup.code));
                return;
            }
            if (pickup.kind === 'key') {
                // 码即密钥，ID 由它的散列在本地算出，服务端不参与。
                location.assign(`/p/${await ShareCode.deriveId(pickup.code)}#${pickup.code}`);
            }
        }

        async showPasteOptions(content) {
            const PASTE_TTL_LABELS = { 5: '5 分钟', 30: '30 分钟', 1440: '1 天', 10080: '7 天' };

            const result = await this.showUiDialog({
                title: '分享保护',
                options: [
                    { kind: 'checkbox', name: 'pin', value: 'on', label: '设置 PIN 码保护', hint: '接收方需输入 PIN 才能查看内容', reveal: true }
                ],
                // 四档有效期排成 2×2：单行「30 分钟」不折行，触摸目标也够大
                groups: [
                    {
                        label: '有效期',
                        options: Object.entries(PASTE_TTL_LABELS).map(([minutes, label], index) => ({
                            kind: 'radio',
                            name: 'ttl',
                            value: minutes,
                            label,
                            checked: index === 0
                        }))
                    }
                ],
                confirmText: '分享',
                closeOnBackdrop: false,
                reveal: { label: '4 位数字 PIN 码', maxlength: 4 },
                validate: (values, choices) => choices.pin && !/^\d{4}$/.test(values[0] || '') ? 'PIN 码必须是 4 位数字' : ''
            });

            // 取消或遮罩关闭：返回 null，不创建分享
            if (!result) return;

            const usePin = !!result.choices.pin;
            const pin = usePin ? result.values[0] : null;
            const ttlMinutes = PASTE_TTL_LABELS[result.choices.ttl] ? Number(result.choices.ttl) : 5;

            // 默认档位不传额外参数，保持既有 createPaste 两参数契约
            if (!pin && ttlMinutes === 5) {
                await this.createPaste(content, null);
            } else {
                await this.createPaste(content, pin, { ttlMinutes });
            }
        }

        async createPaste(content, pin = null, options = {}) {
            try {
                // v2：取件码在浏览器生成，本身就是 128 位密钥。
                // 服务端只拿到散列后的 ID 与密文，拿不到密钥。
                const code = ShareCode.generateCode();
                const id = await ShareCode.deriveId(code);
                const proof = await ShareCode.deriveProof(code);
                const encryptedContent = await Crypto.encryptWithCode(content, code);

                const body = { code: id, content: encryptedContent, proof };
                if (pin) body.pin = pin;
                if (options.ttlMinutes) body.ttl = options.ttlMinutes;

                const res = await fetch('/api/p', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body)
                });
                const data = await res.json();

                if (data.success) {
                    $('#searchInput').value = '';
                    this.pasteMode = false;
                    this.togglePasteMode(false);
                    this.showPasteResult(code, !!pin, data.expiresAt, {
                        kind: 'text',
                        link: `${location.origin}/p/${id}#${ShareCode.normalizeCode(code)}`
                    });
                } else {
                    this.showToast(data.error || '创建分享失败', 'error');
                }
            } catch (e) {
                this.showToast('创建分享失败: ' + e.message, 'error');
            }
        }

        showPasteResult(code, hasPin = false, expiresAt = null, meta = {}) {
            this.hidePasteResult();

            const url = meta.link || `${location.origin}/p/${code}`;
            const pinInfo = hasPin ? '<div class="paste-pin-info">已设置 PIN 保护，请通过另一渠道告知</div>' : '';
            const fileInfo = meta.kind === 'file'
                ? `<div class="paste-file-info">${this.esc(meta.name || '文件')} · ${this.esc(this.formatBytes(meta.size || 0))}</div>`
                : '';
            const longCode = code.length > 18 ? ' is-long' : '';
            const result = html(`
                <div class="paste-result" id="pasteResult">
                    <button class="paste-close" type="button" aria-label="关闭分享结果">×</button>
                    <div class="paste-label">取件码</div>
                    <div class="paste-code${longCode}">${this.esc(code)}</div>
                    ${fileInfo}
                    ${pinInfo}
                    <div class="paste-qr"><img alt="分享链接二维码"></div>
                    <button class="paste-link" type="button" data-url="${this.esc(url)}">复制链接</button>
                    <div class="paste-url">${this.esc(url)}</div>
                    <div class="paste-expiry">${this.esc(this.pasteExpiryText(expiresAt))}</div>
                    <div class="paste-secret-note">取件码和链接等同于访问凭据，请只发给接收者。</div>
                </div>
            `);

            result.querySelector('.paste-close').onclick = () => this.hidePasteResult();

            // 二维码：使用本地图库生成 data URL，失败时静默隐藏，不影响复制链接。
            // qrcode.js 经 loadScript 按需加载，加载完成后再生成，
            // 不阻塞分享结果的展示。
            const qrImg = result.querySelector('.paste-qr img');
            this.loadScript('lib/qrcode.js')
                .then(() => {
                    try {
                        const qr = qrcode(0, 'M');
                        qr.addData(url);
                        qr.make();
                        qrImg.src = qr.createDataURL(6, 2);
                    } catch {
                        qrImg.closest('.paste-qr')?.remove();
                    }
                })
                .catch(() => {
                    qrImg.closest('.paste-qr')?.remove();
                });

            result.querySelector('.paste-link').onclick = async (e) => {
                const link = e.target;
                const copyUrl = link.dataset.url;
                try {
                    await navigator.clipboard.writeText(copyUrl);
                    link.textContent = '已复制';
                    setTimeout(() => { link.textContent = '复制链接'; }, 2000);
                } catch {
                    await this.promptValue('复制链接', '分享链接', { value: copyUrl, readonly: true, confirmText: '关闭' });
                }
            };

            $('#searchForm').after(result);
        }

        pasteExpiryText(expiresAt) {
            if (!expiresAt) return '5分钟后过期';
            const minutes = Math.round((expiresAt - Date.now()) / 60000);
            if (minutes <= 0) return '已过期';
            if (minutes < 60) return `${minutes}分钟后过期`;
            if (minutes < 1440) return `${Math.round(minutes / 60)}小时后过期`;
            return `${Math.round(minutes / 1440)}天后过期`;
        }

        hidePasteResult() {
            const existing = $('#pasteResult');
            if (existing) existing.remove();
        }

        formatBytes(bytes) {
            if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
            const units = ['B', 'KB', 'MB', 'GB', 'TB'];
            const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
            const value = bytes / Math.pow(1024, index);
            return (index === 0 ? String(bytes) : value.toFixed(value >= 10 ? 0 : 1)) + ' ' + units[index];
        }

        // 默认走二期实时直连：5 位码配对，文件不落在服务器上。
        // 浏览器不支持 WebRTC、或直连失败时，回退到一期的服务器中转。
        async shareFile(file) {
            if (!file) return;
            if (!file.size) {
                this.showToast('不能分享空文件', 'error');
                return;
            }
            const rtc = window.RtcTransfer;
            if (rtc && rtc.isSupported()) {
                try {
                    const started = await rtc.share(file, {
                        onFallback: (pendingFile, notifyRelay) => this.shareFileRelay(pendingFile, notifyRelay)
                    });
                    if (started && started.ok) return;
                    if (started && started.reason === 'busy') {
                        this.showToast('已有实时传输正在进行', 'error');
                        return;
                    }
                    if (started && (started.reason === 'too_large' || started.reason === 'error')) return;
                } catch (error) {
                    this.showToast('实时传输启动失败：' + error.message, 'error');
                    return;
                }
            }
            await this.shareFileRelay(file);
        }

        async shareFileRelay(file, notifyRelay = null) {
            // 从实时直连回退过来时，任何没走到上传的出口都要告诉对端已取消，
            // 否则接收方会一直停在「等待取件码」。
            const abortRelay = () => {
                if (typeof notifyRelay === 'function') {
                    try { notifyRelay(null); } catch {}
                }
            };
            if (!file) return abortRelay();
            if (!file.size) {
                this.showToast('不能分享空文件', 'error');
                return abortRelay();
            }

            let limits;
            try {
                limits = await API.get('/api/file/limits');
            } catch (error) {
                this.showToast('读取文件分享配置失败：' + error.message, 'error');
                return abortRelay();
            }
            if (file.size > limits.maxFileBytes) {
                this.showToast(`文件过大，单文件上限 ${this.formatBytes(limits.maxFileBytes)}`, 'error');
                return abortRelay();
            }

            const TTL_LABELS = { 5: '5 分钟', 30: '30 分钟', 1440: '1 天', 10080: '7 天' };
            // 直连失败回退中转时，上传可能要几分钟，默认 5 分钟太紧；
            // 文件失效时间从上传播开始算，接收方还没下载就可能过期。
            const defaultTtl = typeof notifyRelay === 'function' ? 30 : 5;
            const result = await this.showUiDialog({
                title: '分享文件',
                message: `${file.name} · ${this.formatBytes(file.size)}`,
                options: [
                    { kind: 'checkbox', name: 'pin', value: 'on', label: '设置 PIN 码保护', hint: '接收方需输入 PIN 才能下载', reveal: true }
                ],
                groups: [
                    {
                        label: '有效期',
                        options: Object.entries(TTL_LABELS).map(([minutes, label]) => ({
                            kind: 'radio',
                            name: 'ttl',
                            value: minutes,
                            label,
                            checked: Number(minutes) === defaultTtl
                        }))
                    }
                ],
                confirmText: '上传',
                closeOnBackdrop: false,
                reveal: { label: '4 位数字 PIN 码', maxlength: 4 },
                validate: (values, choices) => choices.pin && !/^\d{4}$/.test(values[0] || '') ? 'PIN 码必须是 4 位数字' : ''
            });
            if (!result) return abortRelay();

            const pin = result.choices.pin ? result.values[0] : null;
            const ttlMinutes = TTL_LABELS[result.choices.ttl] ? Number(result.choices.ttl) : 5;
            await this.uploadFile(file, { pin, ttlMinutes, limits, notifyRelay });
        }

        showTransferProgress(fileName, onCancel) {
            const overlay = html(`
                <div class="transfer-progress-overlay">
                    <div class="transfer-progress" role="dialog" aria-modal="true" aria-labelledby="transferProgressTitle">
                        <p class="transfer-progress-title" id="transferProgressTitle">${this.esc(fileName)}</p>
                        <div class="transfer-progress-bar"><span></span></div>
                        <p class="transfer-progress-status" role="status" aria-live="polite">正在准备上传...</p>
                        <p class="transfer-progress-warning">上传期间请不要关闭或刷新此页面，关闭会中断传输。</p>
                        <button class="btn btn-sm" type="button" data-action="cancel">取消</button>
                    </div>
                </div>
            `);
            const bar = overlay.querySelector('.transfer-progress-bar span');
            const status = overlay.querySelector('.transfer-progress-status');
            const cancel = overlay.querySelector('[data-action="cancel"]');
            cancel.onclick = () => {
                cancel.disabled = true;
                status.textContent = '正在取消...';
                onCancel();
            };
            document.body.append(overlay);

            const app = this;
            return {
                update(done, total) {
                    const percent = total ? Math.min(100, Math.round(done / total * 100)) : 0;
                    bar.style.width = `${percent}%`;
                    status.textContent = `正在加密上传 ${percent}%（${app.formatBytes(done)} / ${app.formatBytes(total)}）`;
                },
                close() { overlay.remove(); }
            };
        }

        async uploadFile(file, { pin, ttlMinutes, limits, notifyRelay = null }) {
            const controller = new AbortController();
            const progress = this.showTransferProgress(file.name, () => controller.abort());
            this.transferActive = true;
            let code = null;
            try {
                const codeData = await API.post('/api/file/code', {});
                code = codeData.code;
                if (!code) throw new Error('未分配取件码');

                const chunkSize = limits.chunkSize;
                const chunkBytes = limits.chunkBytes;
                const chunkCount = Math.ceil(file.size / chunkSize);
                const storedSize = file.size + 28 * chunkCount;

                progress.update(0, file.size);
                await API.post('/api/file/init', {
                    code,
                    size: file.size,
                    storedSize,
                    chunkSize,
                    chunkBytes,
                    name: file.name,
                    type: file.type || 'application/octet-stream',
                    pin,
                    ttl: ttlMinutes,
                    downloads: 1
                });

                const key = await Crypto.deriveKey(code);
                for (let index = 0; index < chunkCount; index++) {
                    if (controller.signal.aborted) throw new DOMException('已取消', 'AbortError');
                    const start = index * chunkSize;
                    const end = Math.min(start + chunkSize, file.size);
                    const plain = new Uint8Array(await file.slice(start, end).arrayBuffer());
                    const iv = crypto.getRandomValues(new Uint8Array(12));
                    const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain));
                    const combined = new Uint8Array(iv.length + encrypted.length);
                    combined.set(iv);
                    combined.set(encrypted, iv.length);

                    const { res } = await API.request(`/api/file/${encodeURIComponent(code)}/chunk/${index}`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/octet-stream' },
                        body: combined,
                        signal: controller.signal
                    }, true);
                    if (!res.ok) {
                        const data = await res.json().catch(() => ({}));
                        throw new Error(data.error || '分片上传失败');
                    }
                    progress.update(end, file.size);
                }

                const finished = await API.post(`/api/file/${encodeURIComponent(code)}/finish`, {});
                progress.close();
                // 直连失败回退到中转时，把新的单词取件码送回原会话，
                // 接收方随后自动跳到 /f/<code>。
                if (typeof notifyRelay === 'function') {
                    try { notifyRelay(code); } catch {}
                }
                this.showPasteResult(code, !!pin, finished.expiresAt, {
                    kind: 'file',
                    name: file.name,
                    size: file.size
                });
            } catch (error) {
                progress.close();
                if (code) {
                    fetch(`/api/file/${encodeURIComponent(code)}`, {
                        method: 'DELETE',
                        credentials: 'same-origin',
                        headers: { 'X-Pabu-Request': '1' }
                    }).catch(() => {});
                }
                if (typeof notifyRelay === 'function') {
                    try { notifyRelay(null); } catch {}
                }
                if (error.name !== 'AbortError') {
                    this.showToast('上传失败：' + (error.message || '未知错误'), 'error');
                }
            } finally {
                this.transferActive = false;
            }
        }

        showHelp() {
            const returnFocus = document.activeElement;
            const overlay = html(`<div class="help-overlay" role="dialog" aria-modal="true" aria-labelledby="helpTitle"><div class="help-content"><button class="help-close" type="button">关闭</button><h3 id="helpTitle">Pabu导航</h3><div class="help-section"><strong>导航编辑</strong><p>点击「编辑」增删分类与链接，调整搜索引擎和显示选项。</p></div><div class="help-section"><strong>多端同步</strong><p>点击「同步」用同一口令连接其他设备，导航修改会自动同步。</p></div><div class="help-section"><strong>文本分享</strong><p>搜索框输入 &gt; 编写临时加密文本，通过链接或取件码分享，可设 PIN 和有效期。</p></div><div class="help-section"><strong>文件分享</strong><p>搜索框输入 》 或点击「输入》分享文件」选择文件，生成 5 位取件码。接收方在搜索框输入取件码后，文件通过浏览器直连传输，不经过服务器保存。直连失败时可改用服务器中转，文件加密后暂存，下载一次后删除。</p></div></div></div>`);
            const close = () => { overlay.remove(); if (returnFocus?.isConnected) returnFocus.focus(); };
            overlay.onclick = event => { if (event.target === overlay || event.target.closest('.help-close')) close(); };
            overlay.onkeydown = event => { if (event.key === 'Escape') { event.preventDefault(); close(); } };
            document.body.append(overlay);
            overlay.querySelector('.help-close').focus();
        }

        async openAdminPage() {
            try {
                await this.restoreSession();
                $('#loader')?.remove();
                await this.openAdmin();
            } catch (error) {
                console.error('管理页初始化失败:', error);
                $('#loader')?.remove();
                await this.notice('无法进入管理后台：' + (error.message || '未知错误'));
                location.href = '/';
            }
        }

        async openAdmin() {
            if (this.themeStyleSaving) return;
            this.adminReturnFocus = document.activeElement;
            if (!this.authenticated) {
                const values = await this.showUiDialog({ title: '进入管理', fields: [{ label: '管理密码', type: 'password' }], options: [{ name: 'trustDevice', kind: 'checkbox', value: '1', label: '信任此设备（30 天内免重复登录）', hint: '不勾选则本次登录 24 小时后自动退出' }] });
                if (!values?.values[0]) { if (this.adminPage) location.href = '/'; return; }
                const res = await API.request('/api/verify-password', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-Password': values.values[0] }, body: '{}' });
                if (!res.data?.valid) {
                    await this.notice(res.data?.code === 'locked' ? '登录已暂时锁定' : '密码错误', res.data?.error || '无法进入管理');
                    if (this.adminPage) return this.openAdmin();
                    return;
                }
                if (res.data.passwordChangeRequired) {
                    this.passwordChangeRequired = true;
                    await this.changePassword();
                    if (this.adminPage && !this.authenticated) location.href = '/';
                    return;
                }
                this.privateEpoch = (this.privateEpoch || 0) + 1;
                this.authenticated = true;
                this.sessionTrusted = false;
                this.notifyIdentityChanged();
                API.envChangeNotified = false;
                if (values.choices.trustDevice) this.sessionTrusted = await this.trustDevice();
            }
            if (!this.siteLoaded) await this.loadSiteEditor();
            this.renderAdminPanel();
            if (this.adminPage) {
                $('#adminTitle').textContent = 'Pabu 管理后台';
                $('#cancelBtn').textContent = '返回首页';
            }
            $('#modal').hidden = false; $('#cancelBtn').focus();
        }

        markConfigDirty() {
            this.configDirty = this.siteDirty();
            this.updateConfigStatus();
        }

        updateConfigStatus(message = null, state = '') {
            const status = $('#configSaveStatus');
            if (!status) return;
            status.textContent = message || (this.configDirty ? '有未保存的修改' : '保存后立即发布');
            status.dataset.state = state || (this.configDirty ? 'pending' : '');
        }

        // duration 可选，默认 3500ms。环境变化自动登出需要阅读时间，传 8000。
        showToast(message, state = 'success', duration = 3500) {
            const toast = $('#toast');
            if (!toast) return;
            clearTimeout(this.toastTimer);
            toast.textContent = message;
            toast.dataset.state = state;
            toast.hidden = false;
            this.toastTimer = setTimeout(() => { toast.hidden = true; }, duration);
        }

        showUiDialog({ title, message = '', fields = [], options = [], groups = [], reveal = null, confirmText = '确定', cancelText = '取消', danger = false, notice = false, closeOnBackdrop = true, validate }) {
            const previousFocus = document.activeElement;
            // 分组内的选项同样计入取值与焦点流转，否则 choices.ttl 会永远读不到。
            // 顺序必须与模板渲染顺序一致（options 先、groups 后），allOptions 依赖这一点。
            const allOptions = [...options, ...groups.flatMap(group => group.options)];
            const revealOption = allOptions.find(option => option.reveal) ? reveal : null;
            // 平铺选项与分组内的选项是同一份标记，两处各自维护一份模板必然漂移
            const renderOption = option => `<div class="ui-dialog-option" data-kind="${this.esc(option.kind)}" data-name="${this.esc(option.name)}">
                <label class="ui-dialog-choice">
                    <input type="${option.kind === 'checkbox' ? 'checkbox' : 'radio'}" name="opt_${this.esc(option.name)}" value="${this.esc(option.value)}" ${option.checked ? 'checked' : ''}>
                    <span>${this.esc(option.label)}</span>
                </label>
                ${option.hint ? `<p class="ui-dialog-hint">${this.esc(option.hint)}</p>` : ''}
            </div>`;
            const overlay = html(`
                <div class="ui-dialog-overlay">
                    <div class="ui-dialog" role="dialog" aria-modal="true" aria-labelledby="uiDialogTitle">
                        <h3 id="uiDialogTitle">${this.esc(title)}</h3>
                        ${message ? `<p class="ui-dialog-message">${this.esc(message)}</p>` : ''}
                        <form class="ui-dialog-form">
                            ${fields.map((field, index) => `<label class="ui-dialog-field">
                                <span>${this.esc(field.label)}</span>
                                <input name="field${index}" type="${field.type === 'password' ? 'password' : 'text'}" value="${this.esc(field.value || '')}" placeholder="${this.esc(field.placeholder || '')}" ${field.readonly ? 'readonly' : ''} autocomplete="off">
                            </label>`).join('')}
                            ${options.length ? `<div class="ui-dialog-options is-plain">
                                ${options.map(renderOption).join('')}
                            </div>` : ''}
                            ${revealOption ? `<div class="ui-dialog-reveal" hidden>
                                <label class="ui-dialog-field">
                                    <span>${this.esc(revealOption.label)}</span>
                                    <input name="revealField" type="password" inputmode="numeric" maxlength="${this.esc(revealOption.maxlength || '')}" placeholder="••••" autocomplete="off">
                                </label>
                            </div>` : ''}
                            ${groups.map(group => `<div class="ui-dialog-group">
                                <p class="ui-dialog-group-label">${this.esc(group.label)}</p>
                                <div class="ui-dialog-options">
                                    ${group.options.map(renderOption).join('')}
                                </div>
                            </div>`).join('')}
                            <div class="ui-dialog-error" role="alert"></div>
                            <div class="ui-dialog-actions">
                                ${notice ? '' : `<button class="btn" type="button" data-action="cancel">${this.esc(cancelText)}</button>`}
                                <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" type="submit">${this.esc(confirmText)}</button>
                            </div>
                        </form>
                    </div>
                </div>
            `);
            document.body.appendChild(overlay);
            const dialog = overlay.querySelector('.ui-dialog');
            const form = overlay.querySelector('form');
            const fieldInputs = [...overlay.querySelectorAll('input[name^="field"], .ui-dialog-reveal input')];
            const optionInputs = [...overlay.querySelectorAll('.ui-dialog-option input')];
            const focusables = [...overlay.querySelectorAll('input, button')];
            (fieldInputs[0] || optionInputs[0] || focusables.at(-1)).focus();

            // 复选框可展开同弹窗内的附加区域（如 PIN 输入框）
            const revealBox = overlay.querySelector('.ui-dialog-reveal');
            if (revealBox) {
                const owner = optionInputs[allOptions.findIndex(option => option.reveal)];
                const syncReveal = () => {
                    revealBox.hidden = !owner?.checked;
                    // 展开时把焦点交给 PIN 输入框，收起时交还复选框
                    if (owner?.checked) revealBox.querySelector('input')?.focus();
                };
                owner?.addEventListener('change', syncReveal);
                revealBox.hidden = !owner?.checked;
            }

            return new Promise(resolve => {
                const close = value => {
                    overlay.remove();
                    if (previousFocus?.isConnected) previousFocus.focus();
                    resolve(value);
                };
                overlay.addEventListener('click', event => {
                    if ((closeOnBackdrop && event.target === overlay) || event.target.closest('[data-action="cancel"]')) close(null);
                });
                dialog.addEventListener('keydown', event => {
                    if (event.key === 'Escape') {
                        event.preventDefault();
                        event.stopPropagation();
                        close(null);
                    } else if (event.key === 'Tab') {
                        const first = focusables[0];
                        const last = focusables.at(-1);
                        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
                        if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
                    }
                });
                form.addEventListener('submit', event => {
                    event.preventDefault();
                    const values = fieldInputs.map(input => input.value);
                    const choices = Object.create(null);
                    optionInputs.forEach(input => {
                        if (input.type === 'radio') { if (input.checked) choices[input.closest('.ui-dialog-option').dataset.name] = input.value; }
                        else choices[input.closest('.ui-dialog-option').dataset.name] = input.checked;
                    });
                    const payload = { values, choices };
                    const error = validate?.(values, choices);
                    if (error) {
                        overlay.querySelector('.ui-dialog-error').textContent = error;
                        (fieldInputs[0] || optionInputs[0] || form.querySelector('button[type="submit"]')).focus();
                        return;
                    }
                    close(allOptions.length || fields.length ? payload : true);
                });
            });
        }

        async confirmAction(message, title = '确认操作', danger = false) {
            return !!(await this.showUiDialog({ title, message, danger, confirmText: danger ? '确认删除' : '确定' }));
        }

        async promptValue(title, label, options = {}) {
            const result = await this.showUiDialog({ title, fields: [{ label, ...options }], confirmText: options.confirmText || '确定', validate: options.validate });
            return result ? result.values[0] : null;
        }

        async notice(message, title = '提示') {
            await this.showUiDialog({ title, message, notice: true, confirmText: '知道了' });
        }

        async closeAdmin(force = false) {
            // ⚠️ 保存进行中**必须允许关闭**：配置已经在提交了，没有「未保存的修改」要放弃。
            // 原先这里是无条件的 `if (this.configSaving && !force) return false;`，而「取消」
            // 按钮并没有被禁用（点遮罩、按 Esc 走的是同一条路），于是保存请求慢或卡住时，
            // 右上角那一对看着完好却什么都点不动——用户报的正是这个。
            //
            // ⚠️ 但**只跳过「放弃修改」这一步**，绝不把 `force` 拨成 true 一路放行：
            // `configDirty` 在保存期间仍为 true，走进去就会把内存里的 `config` 回滚成
            // 提交前的快照，保存成功后页面反而显示旧配置，直到刷新才恢复。
            const saving = this.configSaving;
            if (!saving && this.configDirty) {
                if (!force && !await this.confirmAction('站点导航有未保存的修改，确定放弃吗？', '放弃修改')) return false;
                if (this.configSnapshot) this.siteConfig = JSON.parse(this.configSnapshot);
                if (this.siteSurface) this.renderSiteEditor();
            }
            this.configDirty = false;
            this.updateConfigStatus();
            this.applyTheme();
            $('#modal').hidden = true;
            if (this.adminReturnFocus?.isConnected) this.adminReturnFocus.focus();
            return true;
        }

        bindAdminTabs() {
            const tabs = $$('.admin-tab');
            if (!tabs.length) return;

            const select = tab => this.selectAdminTab(tab.dataset.panel);
            for (const tab of tabs) tab.addEventListener('click', () => select(tab));

            const list = $('.admin-tabs');
            list.addEventListener('keydown', event => {
                const current = tabs.findIndex(t => t.getAttribute('aria-selected') === 'true');
                if (current < 0) return;
                let next = null;
                if (event.key === 'ArrowRight') next = (current + 1) % tabs.length;
                else if (event.key === 'ArrowLeft') next = (current - 1 + tabs.length) % tabs.length;
                else if (event.key === 'Home') next = 0;
                else if (event.key === 'End') next = tabs.length - 1;
                if (next === null) return;
                event.preventDefault();
                select(tabs[next]);
                tabs[next].focus();
            });
        }

        /**
         * 切换管理分区并同步键盘焦点状态。
         */
        selectAdminTab(panel) {
            this.adminTab = panel;
            for (const tab of $$('.admin-tab')) {
                const active = tab.dataset.panel === panel;
                tab.setAttribute('aria-selected', String(active)); tab.tabIndex = active ? 0 : -1;
                tab.classList.toggle('is-active', active);
            }
            for (const el of $$('.admin-panel')) el.hidden = el.id !== `adminPanel${panel[0].toUpperCase()}${panel.slice(1)}`;
            if (panel === 'sync') {
                if (!this.syncInvitesRendered) this.renderSyncInvites();
                if (!this.syncSpacesRendered) this.renderSyncSpaces();
            }
        }

        renderAdminPanel() {
            $('#modalBody').innerHTML = `<div class="admin-tabs" role="tablist" aria-label="管理分区">
                <button type="button" class="admin-tab" role="tab" id="adminTabSite" aria-controls="adminPanelSite" data-panel="site">站点导航</button>
                <button type="button" class="admin-tab" role="tab" id="adminTabSync" aria-controls="adminPanelSync" data-panel="sync">用户与数据</button>
                <button type="button" class="admin-tab" role="tab" id="adminTabAccount" aria-controls="adminPanelAccount" data-panel="account">账户</button></div><div class="admin-panels">
                <section class="admin-panel" role="tabpanel" id="adminPanelSite" aria-labelledby="adminTabSite">
                    <div class="section"><div class="section-title">站点默认导航</div><p class="fav-hint">一比一复刻访客默认首页。直接拖拽分类与链接，点 ＋ 增删，编辑后点右上角「保存并发布」生效。</p>
                        <div class="site-canvas" id="siteCanvas"><div class="backboard">
                            <div class="home-theme-toolbar"><div class="home-theme-switcher" id="siteThemeSwitcher" role="group" aria-label="视觉主题"></div></div>
                            <header class="header" id="siteHeader"></header>
                            <div class="search-caption" aria-hidden="true"><span class="caption-action"><kbd>输入&gt;</kbd>分享文本</span><span class="caption-action"><kbd>输入》</kbd>分享文件</span><span class="caption-action"><kbd>输入取件码</kbd> 取回文本文件</span></div>
                            <main class="grid" id="siteGrid"></main>
                            <footer class="site-footer" aria-label="页面操作" aria-hidden="true"><nav class="site-footer-links"><span class="site-footer-link">说明</span><span class="site-footer-sep">·</span><span class="site-footer-link">同步</span><span class="site-footer-sep">·</span><span class="site-footer-link">编辑</span></nav></footer>
                        </div></div>
                    </div>
                    <div class="section"><div class="section-title">站点外观与搜索</div><p class="fav-hint">保存的是所有访客默认看到的外观和搜索引擎。</p>
                        <div class="setting-row"><label><span>视觉主题</span><select id="themeStyleSelect"></select></label></div>
                        <div class="setting-row"><label><span>明暗模式</span><select id="themeModeSelect"><option value="auto">跟随系统</option><option value="light">浅色模式</option><option value="dark">深色模式</option></select></label></div>
                        <div class="setting-row"><label><span>默认搜索引擎</span><select id="defaultEngineSelect"></select></label></div>
                    </div>
                    <div class="section section-collapsible"><button type="button" class="section-header" aria-expanded="false" aria-controls="enginesSection" onclick="app.toggleSection('engines')"><span class="section-title">搜索引擎</span><span class="section-toggle-label">展开</span></button><div class="section-body collapsed" id="enginesSection"><div id="enginesEditor"></div><button class="add-btn" id="addEngine">添加搜索引擎</button></div></div>
                </section>
                <section class="admin-panel" role="tabpanel" id="adminPanelSync" aria-labelledby="adminTabSync" hidden>
                    <div class="section"><div class="section-title">用户与数据概览</div><div class="sync-overview" id="syncOverview"><div class="sync-stat"><b>—</b><span>用户数</span></div><div class="sync-stat"><b>—</b><span>存储占用</span></div><div class="sync-stat"><b>—</b><span>活跃设备</span></div><div class="sync-stat"><b>—</b><span>服务状态</span></div></div>
                    <div class="sync-policy-row"><label class="sync-policy-item"><span>需要邀请码</span><div class="toggle-switch"><input type="checkbox" id="syncInviteRequired"><span class="toggle-slider"></span></div></label><label class="sync-policy-item"><span>暂停新建</span><div class="toggle-switch"><input type="checkbox" id="syncCreatingPaused"><span class="toggle-slider"></span></div></label><label class="sync-policy-item"><span>总暂停</span><div class="toggle-switch"><input type="checkbox" id="syncTotalPaused"><span class="toggle-slider"></span></div></label></div><p id="syncPolicyHint" class="fav-hint"></p></div>
                    <div class="section" id="syncInvitesSection"><div class="section-title">邀请码</div><p class="fav-hint" id="syncInviteHint">邀请码一次性使用，有效期 48 小时。</p><div class="sync-toolbar"><input id="syncInviteNote" maxlength="100" placeholder="备注" aria-label="邀请码备注"><button type="button" class="btn btn-sm" id="createSingleInviteBtn">单个生成</button><select id="syncInviteCount" aria-label="生成数量"><option value="1">1 张</option><option value="5">5 张</option><option value="10" selected>10 张</option><option value="custom">自定义</option></select><input type="number" id="syncInviteCustomCount" min="1" max="20" step="1" value="20" hidden aria-label="自定义张数"><button type="button" class="btn btn-sm btn-primary" id="createInviteBtn">批量生成</button></div><p class="sync-error" id="syncInviteError" hidden></p><div id="syncInviteBatch" hidden></div><div class="sync-toolbar"><select id="syncInviteState" aria-label="邀请码状态"><option value="all">全部</option><option value="unused">未使用</option><option value="used">已使用</option><option value="expired">已过期</option><option value="revoked">已撤销</option></select><button type="button" class="btn btn-sm" id="revokeSelectedInvites" disabled>撤销选中</button><span id="syncInviteCounts" class="sync-toolbar-note"></span></div><div class="sync-invite-list" id="syncInviteList"></div><div class="sync-pager" id="syncInvitePager" hidden></div></div>
                    <div class="section" id="syncSpacesSection"><div class="section-title">同步空间（用户）</div><p class="fav-hint">用户以同步空间表示。管理端只展示元数据，可以编辑备注、停用、删除和重置设备，不读取空间正文或设备凭据。</p><div class="sync-toolbar"><input type="search" id="syncSpaceSearch" placeholder="搜索备注" aria-label="搜索备注"><select id="syncSpaceState" aria-label="空间状态"><option value="all">全部状态</option><option value="active">正常</option><option value="disabled">已停用</option><option value="deleted">已删除</option></select><select id="syncSpaceSort" aria-label="排序方式"><option value="updated">最近更新</option><option value="bytes">体积</option><option value="devices">设备数</option></select></div><div class="sync-toolbar"><button type="button" class="btn btn-sm" id="disableSelectedSpaces" disabled>批量停用</button><span id="syncSpacesSelection" class="sync-toolbar-note"></span><span id="syncSpacesSummary" class="sync-toolbar-note"></span></div><div class="sync-space-host" id="syncSpacesList"></div><p class="sync-scroll-hint">表格可以左右滑动查看更多列</p><div class="sync-pager" id="syncSpacesPager" hidden></div></div>
                </section>
                <section class="admin-panel" role="tabpanel" id="adminPanelAccount" aria-labelledby="adminTabAccount" hidden><div class="section"><div class="section-title">登录安全</div><div class="setting-row"><label><span>信任此设备</span><div class="toggle-switch"><input type="checkbox" id="trustDeviceToggle"><span class="toggle-slider"></span></div></label></div><p class="fav-hint" id="trustDeviceHint"></p></div><div class="section"><button class="btn btn-danger" id="logoutBtn" style="width:100%">退出登录</button></div></section></div>`;
            this.bindAdminTabs();
            $('#saveBtn').textContent = '保存并发布';
            this.syncInvitesRendered = false;
            this.syncSpacesRendered = false;
            this.syncInviteBatch = null;
            this.selectAdminTab(this.adminTab || 'site');
            if (this.siteLoaded) this.mountSiteEditor();
            this.renderSiteControls();
            $('#createSingleInviteBtn').onclick = () => this.createSyncInvites(true);
            $('#createInviteBtn').onclick = () => this.createSyncInvites();
            $('#syncInviteList').addEventListener('click', event => { if (event.target.dataset.action === 'revoke-invite') this.revokeSyncInvite(event.target.dataset.id); if (event.target.dataset.action === 'retry-invites') { this.syncInvites = null; this.syncInvitesRendered = false; this.renderSyncInvites(); } });
            $('#syncInviteList').addEventListener('change', event => { const id = event.target.dataset.selectInvite; if (id) this.toggleSyncInviteSelection(id, event.target.checked); });
            $('#syncInviteBatch').addEventListener('click', event => { if (event.target.dataset.action === 'copy-invite-batch') this.copySyncInviteBatch(); if (event.target.dataset.action === 'download-invite-batch') this.downloadSyncInviteBatch(); });
            $('#syncInvitePager').addEventListener('click', event => { const step = this.syncInvitesFilter.limit || SYNC_PAGE_SIZE; if (event.target.dataset.action === 'invites-prev') { this.syncInvitesFilter.offset = Math.max(0, this.syncInvitesFilter.offset - step); this.renderSyncInvites(); } if (event.target.dataset.action === 'invites-next') { this.syncInvitesFilter.offset += step; this.renderSyncInvites(); } });
            $('#syncInviteCount').onchange = event => { $('#syncInviteCustomCount').hidden = event.target.value !== 'custom'; this.showSyncInviteError(''); };
            $('#syncInviteState').onchange = event => { this.syncInvitesFilter.state = event.target.value; this.syncInvitesFilter.offset = 0; this.syncInviteSelected.clear(); this.renderSyncInvites(); };
            $('#revokeSelectedInvites').onclick = () => this.revokeSelectedInvites();
            $('#syncSpacesList').addEventListener('click', event => {
                const action = event.target.dataset.action;
                if (action === 'toggle-space') this.toggleSyncSpace(event.target.dataset.id, event.target.dataset.disabled === '1');
                if (action === 'delete-space') this.deleteSyncSpace(event.target.dataset.id);
                if (action === 'edit-note') this.editSyncSpaceNote(event.target.dataset.id);
                if (action === 'reset-devices') this.resetSyncSpaceDevices(event.target.dataset.id);
                if (action === 'retry-spaces') { this.syncSpacesRendered = false; this.renderSyncSpaces(); }
            });
            $('#syncInviteRequired').onchange = $('#syncCreatingPaused').onchange = $('#syncTotalPaused').onchange = () => this.saveSyncPolicy();
            $('#syncSpacesList').addEventListener('change', event => { if (event.target.id === 'syncSpacesSelectAll') this.toggleAllSyncSpaces(event.target.checked); else if (event.target.dataset.selectSpace) this.toggleSyncSpaceSelection(event.target.dataset.selectSpace, event.target.checked); });
            $('#syncSpacesPager').addEventListener('click', event => { const step = this.syncSpacesFilter.limit || SYNC_PAGE_SIZE; if (event.target.dataset.action === 'spaces-prev') { this.syncSpacesFilter.offset = Math.max(0, this.syncSpacesFilter.offset - step); this.renderSyncSpaces(); } if (event.target.dataset.action === 'spaces-next') { this.syncSpacesFilter.offset += step; this.renderSyncSpaces(); } });
            $('#syncInviteState').value = this.syncInvitesFilter.state; $('#syncSpaceState').value = this.syncSpacesFilter.state; $('#syncSpaceSort').value = this.syncSpacesFilter.sort; $('#syncSpaceSearch').value = this.syncSpacesFilter.q;
            $('#disableSelectedSpaces').onclick = () => this.disableSelectedSyncSpaces();
            $('#syncSpaceSearch').oninput = event => { clearTimeout(this.syncSpacesSearchTimer); const value = event.target.value.trim(); this.syncSpacesSearchTimer = setTimeout(() => { this.syncSpacesFilter.q = value; this.syncSpacesFilter.offset = 0; this.syncSpacesSelected.clear(); this.renderSyncSpaces(); }, 300); };
            $('#syncSpaceState').onchange = event => { this.syncSpacesFilter.state = event.target.value; this.syncSpacesFilter.offset = 0; this.syncSpacesSelected.clear(); this.renderSyncSpaces(); };
            $('#syncSpaceSort').onchange = event => { this.syncSpacesFilter.sort = event.target.value; this.syncSpacesFilter.offset = 0; this.renderSyncSpaces(); };
            this.paintSyncPolicy(); this.paintSyncSpacesBulk(); this.paintSyncInviteBatch();
            this.syncAdminSelects();
            $('#trustDeviceToggle').checked = this.sessionTrusted;
            $('#trustDeviceToggle').onchange = async event => { const toggle = event.target, wanted = toggle.checked; toggle.disabled = true; const ok = await this.setDeviceTrust(wanted); toggle.disabled = false; if (ok !== wanted) { toggle.checked = !wanted; this.sessionTrusted = !wanted; } this.updateTrustDeviceHint(); };
            this.updateTrustDeviceHint();
            $('#logoutBtn').onclick = async () => {
                if (this.navigationSaving || this.configSaving) { this.showToast('正在保存，请等待结果后退出', 'error'); return; }
                if (this.pendingNavigation) { this.showToast('上次保存结果尚未确认，请重试保存后再退出', 'error', 8000); return; }
                if (!await this.closeAdmin()) return;
                try { const result = await API.post('/api/logout', {}); if (!result.success) throw new Error(); } catch { this.showToast('退出请求失败，请检查网络后重试', 'error'); return; }
                this.clearPrivateState(); this.notifyIdentityChanged(); await this.refreshLocalNavigation();
                if (this.adminPage) location.href = '/';
            };
        }

        toggleSection(sectionId) {
            const section = $(`#${sectionId}Section`), header = section?.previousElementSibling;
            if (!section || !header) return;
            section.classList.toggle('collapsed'); header.classList.toggle('expanded');
            const expanded = !section.classList.contains('collapsed');
            header.setAttribute('aria-expanded', String(expanded));
            header.querySelector('.section-toggle-label').textContent = expanded ? '收起' : '展开';
        }

        renderSiteControls() {
            const config = this.siteConfig;
            if (!config) return;
            this.renderEnginesEditor();

            const styleSelect = $('#themeStyleSelect');
            if (styleSelect) {
                this.renderThemeStyleSelect(styleSelect, config);
                styleSelect.onchange = event => {
                    config.themeStyle = event.target.value;
                    this.applySitePreviewTheme();
                    this.renderSiteThemeSwitcher();
                    this.renderSiteHeader();
                    this.markConfigDirty();
                };
            }

            const modeSelect = $('#themeModeSelect');
            if (modeSelect) {
                const appearance = window.NavigationSchema.appearance(config);
                modeSelect.disabled = !!window.NavigationSchema.THEMES[appearance.style].mode;
                modeSelect.value = appearance.mode;
                modeSelect.onchange = event => {
                    config.theme = event.target.value;
                    this.applySitePreviewTheme();
                    this.markConfigDirty();
                };
            }

            const engineSelect = $('#defaultEngineSelect');
            if (engineSelect) {
                engineSelect.innerHTML = config.searchEngines.map(engine =>
                    `<option value="${this.esc(engine.id)}" ${engine.id === config.searchEngine ? 'selected' : ''}>${this.esc(engine.name)}</option>`).join('');
                engineSelect.onchange = event => {
                    config.searchEngine = event.target.value;
                    this.renderSiteHeader();
                    this.markConfigDirty();
                };
            }

            const addEngine = $('#addEngine');
            if (addEngine) addEngine.onclick = () => {
                config.searchEngines.push({ id: uid(), name: '新引擎', url: 'https://' });
                this.renderEnginesEditor();
                this.renderSiteHeader();
                this.markConfigDirty();
            };
            this.syncAdminSelects();
        }

        renderEnginesEditor() {
            const container = $('#enginesEditor');
            const config = this.siteConfig;
            if (!container || !config) return;
            container.innerHTML = config.searchEngines.map((e, i) => `
                <div class="item" data-idx="${i}">
                    <div class="item-row">
                        <input type="text" value="${this.esc(e.name)}" data-field="name" placeholder="名称">
                        <input type="text" value="${this.esc(e.url)}" data-field="url" placeholder="URL">
                        <button class="btn btn-danger btn-sm del-engine">删除</button>
                    </div>
                </div>
            `).join('');

            container.oninput = (e) => {
                const item = e.target.closest('.item');
                if (!item) return;
                const idx = +item.dataset.idx;
                const field = e.target.dataset.field;
                if (field) {
                    config.searchEngines[idx][field] = e.target.value;
                    this.markConfigDirty();
                }
            };

            container.onclick = (e) => {
                if (e.target.classList.contains('del-engine')) {
                    const idx = +e.target.closest('.item').dataset.idx;
                    if (config.searchEngines.length <= 1) { this.showToast('至少保留一个搜索引擎', 'error'); return; }
                    const deleted = config.searchEngines.splice(idx, 1)[0];
                    if (config.searchEngine === deleted.id) {
                        config.searchEngine = config.searchEngines[0].id;
                    }
                    this.renderEnginesEditor();
                    this.renderSiteHeader();
                    this.markConfigDirty();
                }
            };
        }


        async save() {
            const button = $('#saveBtn');
            if (button.disabled) return;
            this.configSaving = true;
            button.disabled = true;
            $('#modalBody').inert = true;
            button.textContent = '发布中...';
            this.updateConfigStatus('正在发布站点导航', 'pending');
            const signal = typeof AbortSignal !== 'undefined' && AbortSignal.timeout
                ? AbortSignal.timeout(20000) : undefined;
            const reportFailure = message => {
                this.updateConfigStatus(message, 'error');
                this.showToast(message, 'error');
            };
            try {
                const res = await this.saveSiteNavigation({ signal });
                if (res.success) {
                    this.renderSiteEditor();
                    this.updateConfigStatus('已发布', 'success');
                    this.showToast('站点导航已保存并发布');
                } else {
                    reportFailure(res.error || '保存失败，请重试');
                }
            } catch (e) {
                const aborted = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
                const locked = e && (e.code === 'busy' || e.code === 'restore_halted');
                reportFailure(aborted ? '保存超时，请检查连接后重试'
                    : locked ? '正在执行另一项管理操作，请稍后重试'
                        : '保存失败，请检查连接后重试');
            } finally {
                this.configSaving = false;
                $('#modalBody').inert = false;
                button.disabled = false;
                button.textContent = '保存并发布';
            }
        }

        async changePassword() {
            if (!this.authenticated && !this.passwordChangeRequired) { await this.notice('请先进入管理模式'); return; }
            // 必须填当前密码：服务端只凭会话不放行改密码，
            // 这是为了防止拿到会话的人直接改掉密码完成接管。
            const values = await this.showUiDialog({
                title: this.passwordChangeRequired ? '密码强度不足，请修改密码；取消将退出' : '修改管理密码',
                fields: [
                    { label: '当前密码', type: 'password' },
                    { label: '新密码', type: 'password' },
                    { label: '再次输入新密码', type: 'password' }
                ],
                validate: ([cur, newPwd, repeated]) =>
                    !cur ? '请输入当前密码'
                        : !(newPwd.length >= 12 && new TextEncoder().encode(newPwd).length <= 72 && [/[A-Z]/, /[a-z]/, /[0-9]/, /[^A-Za-z0-9\s]/].filter(re => re.test(newPwd)).length >= 3) ? '密码至少12个字符，包含大写、小写、数字、符号中至少三类，且不超过72字节'
                        : newPwd !== repeated ? '两次输入不一致' : ''
            });
            if (!values) {
                if (this.passwordChangeRequired) {
                    await API.post('/api/logout', {});
                    this.passwordChangeRequired = false;
                }
                return;
            }
            const currentPwd = values.values[0];
            const newPwd = values.values[1];

            const res = await API.post('/api/change-password', {
                currentPassword: currentPwd,
                newPassword: newPwd
            });
            if (res.success) {
                this.passwordChangeRequired = false;
                this.clearPrivateState();
                try { localStorage.setItem('pabu-auth-reset', String(Date.now())); } catch {}
                location.reload();
            } else {
                this.showToast(res.error || '修改失败', 'error');
            }
        }

        esc(str) {
            return String(str ?? '').replace(/[&<>"']/g, char => ESC_MAP[char]);
        }
    }

    const bookmarkIconMethods = Object.getOwnPropertyDescriptors(window.BookmarkIconMethods);
    delete bookmarkIconMethods.constructor;
    Object.defineProperties(App.prototype, bookmarkIconMethods);

    let app;
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => { app = new App(); window.app = app; });
    } else {
        app = new App();
        window.app = app;
    }

})(window);
