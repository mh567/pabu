((root) => {
    'use strict';

    root.createAdminMethods = ({ $, $$, html, uid, API, SYNC_PAGE_SIZE }) => {
        class AdminPanel {
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
        }

        return AdminPanel.prototype;
    };
})(window);
