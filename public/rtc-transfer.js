((window) => {
    'use strict';

    // 二期实时传文件：发送方创建 5 位数字取件码，接收方在超级搜索框输入后
    // 双方通过 WebRTC DataChannel 直连。服务端只转发 SDP/ICE，不接触文件内容。
    //
    // 取舍：
    // · 单文件、单接收方、一次性会话。接收方离开后发送方可以等下一个接收方。
    // · 16 KiB 分片可靠有序，用 bufferedAmount 做背压，避免灌爆 SCTP 缓冲。
    // · 直连失败不自动重试，由发送方选择回退到一期服务器中转。
    // · DTLS 已经保证链路加密；额外显示 4 位确认码，用来发现信令被替换。

    const CHUNK_SIZE = 16 * 1024;
    const BUFFER_HIGH = 1024 * 1024;
    const BUFFER_LOW = 256 * 1024;
    const ICE_TIMEOUT_MS = 25000;
    const SAS_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const SAS_LENGTH = 4;

    const $ = (sel, ctx = document) => ctx.querySelector(sel);
    const esc = value => String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    const html = str => {
        const template = document.createElement('template');
        template.innerHTML = str.trim();
        return template.content.firstChild;
    };
    const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

    function formatBytes(bytes) {
        if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
        const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
        const value = bytes / Math.pow(1024, index);
        return (index === 0 ? String(bytes) : value.toFixed(value >= 10 ? 0 : 1)) + ' ' + units[index];
    }

    function supportsRtc() {
        return typeof window.RTCPeerConnection === 'function'
            && !!(window.crypto && window.crypto.subtle);
    }

    async function request(path, options = {}) {
        const headers = { 'X-Pabu-Request': '1' };
        if (options.body !== undefined) headers['Content-Type'] = 'application/json';
        if (options.token) headers['X-Pabu-Rtc-Token'] = options.token;
        const res = await fetch(path, {
            method: options.method || 'POST',
            credentials: 'same-origin',
            cache: 'no-store',
            headers,
            body: options.body === undefined ? undefined : JSON.stringify(options.body),
            signal: options.signal
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            throw Object.assign(new Error(data.error || '请求失败'), { status: res.status, code: data.code });
        }
        return data;
    }

    // 从双方 SDP 的 DTLS 指纹派生 4 位确认码。顺序固定（排序后拼接），
    // 两端算出的结果一致；信令被中间人替换时两端会看到不同的码。
    async function deriveSas(pc) {
        if (!pc.localDescription || !pc.remoteDescription) return '';
        const fingerprints = [];
        for (const description of [pc.localDescription, pc.remoteDescription]) {
            const match = /a=fingerprint:sha-256 ([0-9A-Fa-f:]+)/.exec(description.sdp || '');
            if (!match) return '';
            fingerprints.push(match[1].toUpperCase());
        }
        fingerprints.sort();
        const digest = await window.crypto.subtle.digest(
            'SHA-256',
            new TextEncoder().encode(fingerprints.join('|'))
        );
        const bytes = new Uint8Array(digest);
        let code = '';
        for (let index = 0; index < SAS_LENGTH; index++) {
            code += SAS_ALPHABET[bytes[index] % SAS_ALPHABET.length];
        }
        return code;
    }

    class RtcTransfer {
        constructor() {
            this.active = false;
            this.mode = null;
            this.overlay = null;
            this.code = null;
            this.token = null;
            this.file = null;
            this.room = null;
            this.config = null;
            this.options = {};

            this.pc = null;
            this.dc = null;
            this.remoteDescriptionSet = false;
            this.pendingCandidates = [];
            this.pollController = null;
            this.iceTimer = null;
            this.lastProgressAt = 0;

            this.closed = false;
            this.finished = false;
            this.started = false;
            this.transferring = false;
            this.fallbackActive = false;
            this.peerJoined = false;
            this.sas = '';

            this.receivedChunks = [];
            this.receivedBytes = 0;
            this.expected = null;
            this.incoming = null;
            this.sentBytes = 0;
            this.progressBar = null;
            this.progressStatus = null;
            this.wakeLock = null;

            window.addEventListener('beforeunload', event => {
                if (!this.transferring) return;
                event.preventDefault();
                event.returnValue = '';
            });
            document.addEventListener('visibilitychange', () => {
                if (document.visibilityState === 'visible' && this.transferring) this.requestWakeLock();
            });
        }

        isSupported() {
            return supportsRtc();
        }

        async getConfig() {
            if (this.config) return this.config;
            this.config = await request('/api/rtc/config', { method: 'GET' });
            return this.config;
        }

        // ---------- 发送方 ----------

        async share(file, options = {}) {
            if (!file) return { ok: false, reason: 'empty' };
            if (!supportsRtc()) return { ok: false, reason: 'unsupported' };
            if (this.active) return { ok: false, reason: 'busy' };

            let config;
            try {
                config = await this.getConfig();
            } catch (error) {
                return { ok: false, reason: 'config', error };
            }
            if (!Number.isInteger(file.size) || file.size <= 0) {
                this.toast('不能分享空文件', 'error');
                return { ok: false, reason: 'empty' };
            }
            if (file.size > config.maxFileBytes) {
                this.toast(`文件过大，实时传输上限 ${formatBytes(config.maxFileBytes)}`, 'error');
                return { ok: false, reason: 'too_large' };
            }

            let room;
            try {
                room = await request('/api/rtc/room', {
                    body: { name: file.name, size: file.size, type: file.type || 'application/octet-stream' }
                });
            } catch (error) {
                this.toast('创建取件码失败：' + error.message, 'error');
                return { ok: false, reason: 'error', error };
            }

            this.resetSession();
            this.active = true;
            this.mode = 'send';
            this.file = file;
            this.code = room.code;
            this.token = room.token;
            this.room = room.room;
            this.options = options;
            this.createOverlay('实时传文件');
            this.renderWaiting();
            this.pollLoop();
            return { ok: true };
        }

        renderWaiting() {
            if (!this.overlay) return;
            this.paint({
                file: this.file,
                code: this.code,
                status: '等待接收方在搜索框输入这 5 位取件码',
                warning: '双方需要同时在线，传输期间请不要关闭或刷新页面。',
                buttons: [
                    { label: '复制取件码', action: 'copy' },
                    { label: '改用服务器中转', action: 'fallback' },
                    { label: '取消', action: 'cancel', danger: true }
                ]
            });
        }

        onPeerJoined() {
            if (this.mode !== 'send' || this.peerJoined || this.closed) return;
            // 已经切换到服务器中转后，新加入的接收方只需要等中转取件码。
            if (this.fallbackActive) {
                this.peerJoined = true;
                this.sendControl('relay-pending').catch(() => {});
                return;
            }
            this.peerJoined = true;
            this.paint({
                file: this.file,
                code: this.code,
                status: '接收方已加入，正在建立直连…',
                warning: '传输期间请不要关闭或刷新页面。',
                buttons: [{ label: '取消', action: 'cancel', danger: true }]
            });
            this.startOffer().catch(error => this.onConnectionFailed(error.message));
        }

        async startOffer() {
            if (this.pc) return;
            this.pendingCandidates = [];
            this.started = false;
            this.finished = false;
            this.sentBytes = 0;
            this.createPeer(false);
            const dc = this.pc.createDataChannel('pabu-file', { ordered: true });
            this.bindChannel(dc);
            const offer = await this.pc.createOffer();
            await this.pc.setLocalDescription(offer);
            this.sendSignal({ type: 'offer', sdp: this.pc.localDescription.sdp });
            this.startIceTimer();
        }

        // ---------- 接收方 ----------

        async receive(code) {
            if (!window.ShareCode || !window.ShareCode.isRtcCode(code)) return false;
            if (!supportsRtc()) {
                this.toast('当前浏览器不支持实时传输，请通过 HTTPS 访问', 'error');
                return false;
            }
            if (this.active) {
                this.toast('已有实时传输正在进行', 'error');
                return false;
            }

            let config;
            try {
                config = await this.getConfig();
            } catch (error) {
                this.toast('读取实时传输配置失败：' + error.message, 'error');
                return false;
            }

            let joined;
            try {
                joined = await request('/api/rtc/join', { body: { code } });
            } catch (error) {
                if (error.status === 404) this.toast('取件码不存在或已过期', 'error');
                else if (error.status === 409) this.toast('这个取件码已被接收方使用', 'error');
                else this.toast(error.message || '加入会话失败', 'error');
                return false;
            }

            this.resetSession();
            this.active = true;
            this.mode = 'receive';
            this.code = code;
            this.token = joined.token;
            this.room = joined.room;
            this.incoming = { name: joined.room.name, size: joined.room.size, type: joined.room.type };
            this.createOverlay('接收文件');
            this.paint({
                file: this.incoming,
                status: '已找到文件，正在等待发送方建立直连…',
                warning: '传输期间请不要关闭或刷新页面。',
                buttons: [{ label: '取消', action: 'cancel', danger: true }]
            });
            this.pollLoop();
            return true;
        }

        // ---------- 信令 ----------

        async pollLoop() {
            while (!this.closed) {
                let data;
                try {
                    this.pollController = new AbortController();
                    data = await request('/api/rtc/poll', {
                        token: this.token,
                        body: { code: this.code, after: this.after || 0 },
                        signal: this.pollController.signal
                    });
                } catch (error) {
                    this.pollController = null;
                    if (this.closed || error.name === 'AbortError') return;
                    if ([403, 404, 410].includes(error.status)) {
                        this.onRoomGone(error);
                        return;
                    }
                    await delay(error.status === 429 ? 5000 : 1000);
                    continue;
                }
                this.pollController = null;
                if (this.closed) return;
                this.after = Number(data.next) || this.after || 0;
                for (const message of data.messages || []) {
                    if (this.closed) return;
                    try { await this.handleSignal(message); }
                    catch (error) { console.error('[RTC] 处理信令失败', error); }
                }
                if (data.state === 'closed' && !(data.messages || []).length) {
                    this.onRoomGone(Object.assign(new Error('会话已结束'), { status: 410 }));
                    return;
                }
            }
        }

        async handleSignal(message) {
            if (!message || typeof message !== 'object') return;
            if (message.type === 'offer' && this.mode === 'receive') return this.handleOffer(message);
            if (message.type === 'answer' && this.mode === 'send') return this.handleAnswer(message);
            if (message.type === 'candidate') return this.handleCandidate(message);
            if (message.type === 'control') return this.handleControl(message);
        }

        sendSignal(message) {
            if (this.closed) return Promise.resolve();
            return request('/api/rtc/send', {
                token: this.token,
                body: { code: this.code, message }
            }).catch(error => {
                console.warn('[RTC] 发送信令失败', error.message);
            });
        }

        sendControl(event, extra = {}) {
            return this.sendSignal({ type: 'control', event, ...extra });
        }

        async handleOffer(message) {
            if (this.pc || this.mode !== 'receive') return;
            this.createPeer(true);
            await this.pc.setRemoteDescription({ type: 'offer', sdp: message.sdp });
            this.remoteDescriptionSet = true;
            await this.flushCandidates();
            const answer = await this.pc.createAnswer();
            await this.pc.setLocalDescription(answer);
            this.sendSignal({ type: 'answer', sdp: this.pc.localDescription.sdp });
            this.startIceTimer();
        }

        async handleAnswer(message) {
            if (!this.pc || this.remoteDescriptionSet) return;
            await this.pc.setRemoteDescription({ type: 'answer', sdp: message.sdp });
            this.remoteDescriptionSet = true;
            await this.flushCandidates();
        }

        async handleCandidate(message) {
            // 候选可能比 offer/answer 先到：先存着，等远端描述就绪再补。
            if (!this.pc || !this.remoteDescriptionSet) {
                this.pendingCandidates.push(message.candidate);
                return;
            }
            if (!message.candidate) return;
            try { await this.pc.addIceCandidate(message.candidate); }
            catch (error) { console.warn('[RTC] 添加网络候选失败', error.message); }
        }

        async flushCandidates() {
            const pending = this.pendingCandidates;
            this.pendingCandidates = [];
            for (const candidate of pending) {
                if (!candidate) continue;
                try { await this.pc.addIceCandidate(candidate); }
                catch (error) { console.warn('[RTC] 添加网络候选失败', error.message); }
            }
        }

        handleControl(message) {
            const event = message.event;
            if (event === 'peer-joined') return this.onPeerJoined();
            if (event === 'peer-left') return this.onPeerLeft();
            if (event === 'cancelled') return this.onRoomGone(Object.assign(new Error('会话已取消'), { status: 410 }));
            if (event === 'expired') return this.onRoomGone(Object.assign(new Error('取件码已过期'), { status: 410 }));
            if (event === 'overflow') return this.onRoomGone(Object.assign(new Error('信令过多，会话已结束'), { status: 410 }));
            if (event === 'relay-pending' && this.mode === 'receive') {
                this.paint({
                    file: this.incoming,
                    status: '直连不可用，发送方正在改用服务器中转…',
                    warning: '请保持页面打开，取件码稍后会自动送达。',
                    buttons: [{ label: '取消', action: 'cancel', danger: true }]
                });
                return;
            }
            if (event === 'relay' && this.mode === 'receive' && message.code) {
                this.toast('发送方已改用服务器中转，正在打开取件页');
                this.close({ keepRoom: true, silent: true });
                window.location.assign('/f/' + encodeURIComponent(message.code));
                return;
            }
            if (event === 'start' && this.mode === 'receive') {
                if (!this.finished) {
                    this.paint({
                        file: this.incoming,
                        status: '正在接收文件…',
                        warning: '传输期间请不要关闭或刷新页面。',
                        progress: true,
                        buttons: [{ label: '取消', action: 'cancel', danger: true }]
                    });
                }
                return;
            }
            if (event === 'received' && this.mode === 'send') {
                this.finished = true;
                this.transferActive(false);
                this.paint({
                    file: this.file,
                    status: '接收方已保存文件',
                    buttons: [{ label: '关闭', action: 'close', primary: true }]
                });
                // 一次性会话：接收方确认保存后关闭房间，取件码不能再次使用。
                setTimeout(() => this.close({ keepRoom: false }), 1500);
            }
        }

        onPeerLeft() {
            if (this.mode !== 'send') return;
            this.resetPeer();
            this.peerJoined = false;
            this.started = false;
            this.finished = false;
            this.sentBytes = 0;
            this.transferring = false;
            this.transferActive(false);
            this.renderWaiting();
        }

        // ---------- WebRTC ----------

        createPeer(isReceiver) {
            this.closePeer();
            const pc = new RTCPeerConnection({
                iceServers: this.config.iceServers || [],
                iceTransportPolicy: 'all',
                bundlePolicy: 'max-bundle'
            });
            this.pc = pc;
            pc.onicecandidate = event => {
                if (event.candidate) {
                    this.sendSignal({ type: 'candidate', candidate: event.candidate.toJSON() });
                } else {
                    this.sendSignal({ type: 'candidate', candidate: null });
                }
            };
            pc.oniceconnectionstatechange = () => {
                if (pc.iceConnectionState === 'failed') this.onConnectionFailed('直连失败，可能受网络或 NAT 限制');
                if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') this.clearIceTimer();
            };
            pc.onconnectionstatechange = () => {
                if (pc.connectionState === 'failed') this.onConnectionFailed('直连失败，可能受网络或 NAT 限制');
                if (pc.connectionState === 'connected') this.clearIceTimer();
            };
            if (isReceiver) {
                pc.ondatachannel = event => this.bindChannel(event.channel);
            }
        }

        bindChannel(channel) {
            this.dc = channel;
            channel.binaryType = 'arraybuffer';
            channel.bufferedAmountLowThreshold = BUFFER_LOW;
            channel.onopen = () => this.onChannelOpen();
            channel.onmessage = event => this.onChannelMessage(event.data);
            channel.onclose = () => {
                if (this.closed || this.finished) return;
                if (this.mode === 'receive') {
                    this.onConnectionFailed('连接已断开，请让发送方重新分享');
                }
            };
            channel.onerror = () => {};
        }

        async onChannelOpen() {
            this.clearIceTimer();
            try { this.sas = await deriveSas(this.pc); }
            catch { this.sas = ''; }
            if (this.closed) return;
            if (this.mode === 'send') {
                this.paint({
                    file: this.file,
                    code: this.code,
                    status: '直连已建立',
                    verify: this.sas,
                    hint: '与接收方核对这 4 位确认码，一致后再开始传输。',
                    warning: '传输期间请不要关闭或刷新页面。',
                    buttons: [
                        { label: '确认并开始传输', action: 'send', primary: true },
                        { label: '改用服务器中转', action: 'fallback' },
                        { label: '取消', action: 'cancel', danger: true }
                    ]
                });
            } else {
                this.paint({
                    file: this.incoming,
                    status: '直连已建立',
                    verify: this.sas,
                    hint: '与发送方核对这 4 位确认码，一致后等待发送方开始传输。',
                    warning: '传输期间请不要关闭或刷新页面。',
                    buttons: [{ label: '取消', action: 'cancel', danger: true }]
                });
            }
        }

        onChannelMessage(data) {
            if (typeof data === 'string') {
                let message;
                try { message = JSON.parse(data); }
                catch { return; }
                if (message.type === 'meta') {
                    this.incoming = {
                        name: String(message.name || '文件'),
                        size: Number(message.size) || 0,
                        type: String(message.mime || 'application/octet-stream')
                    };
                    this.expected = this.incoming.size;
                    this.receivedChunks = [];
                    this.receivedBytes = 0;
                    this.transferring = true;
                    this.lastProgressAt = 0;
                    this.transferActive(true);
                    this.requestWakeLock();
                    this.paint({
                        file: this.incoming,
                        status: '正在接收文件…',
                        warning: '传输期间请不要关闭或刷新页面。',
                        progress: true,
                        buttons: [{ label: '取消', action: 'cancel', danger: true }]
                    });
                    return;
                }
                if (message.type === 'done') {
                    this.finishReceive();
                    return;
                }
                if (message.type === 'cancel') {
                    this.onRoomGone(Object.assign(new Error('发送方已取消'), { status: 410 }));
                }
                return;
            }

            const chunk = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer || data);
            if (!this.expected) return;
            this.receivedBytes += chunk.byteLength;
            if (this.receivedBytes > this.expected) {
                this.onConnectionFailed('接收到的数据超过文件大小');
                return;
            }
            this.receivedChunks.push(chunk);
            this.updateProgress(this.receivedBytes, this.expected);
        }

        async startSending() {
            if (this.started || this.finished) return;
            if (!this.dc || this.dc.readyState !== 'open') return;
            this.started = true;
            this.transferring = true;
            this.lastProgressAt = 0;
            this.progressBar = null;
            this.transferActive(true);
            this.requestWakeLock();
            this.sendControl('start');
            this.paint({
                file: this.file,
                status: '正在发送 0%',
                warning: '传输期间请不要关闭或刷新页面。',
                progress: true,
                buttons: [{ label: '取消', action: 'cancel', danger: true }]
            });
            try {
                // 消息类型用 type，MIME 用 mime。同一对象里不能写两个 type，
                // 否则后一个会覆盖 meta，接收端会把它当成未知消息丢掉。
                this.dc.send(JSON.stringify({
                    type: 'meta',
                    name: this.file.name,
                    size: this.file.size,
                    mime: this.file.type || 'application/octet-stream'
                }));
                for (let offset = 0; offset < this.file.size; offset += CHUNK_SIZE) {
                    if (this.closed) throw new DOMException('已取消', 'AbortError');
                    await this.waitForBuffer();
                    if (!this.dc || this.dc.readyState !== 'open') throw new Error('连接已断开');
                    const slice = await this.file.slice(offset, offset + CHUNK_SIZE).arrayBuffer();
                    this.dc.send(slice);
                    this.sentBytes += slice.byteLength;
                    this.updateProgress(this.sentBytes, this.file.size);
                }
                this.dc.send(JSON.stringify({ type: 'done' }));
                this.finished = true;
                this.transferring = false;
                this.transferActive(false);
                this.releaseWakeLock();
                this.sentBytes = this.file.size;
                this.paint({
                    file: this.file,
                    status: '已发送完成，等待接收方保存…',
                    hint: '接收方保存后会自动结束会话。',
                    buttons: [{ label: '关闭', action: 'close' }]
                });
            } catch (error) {
                if (error.name === 'AbortError') return;
                this.onConnectionFailed(error.message || '发送失败');
            }
        }

        async waitForBuffer() {
            if (!this.dc || this.dc.bufferedAmount < BUFFER_HIGH) return;
            await new Promise(resolve => {
                let settled = false;
                const channel = this.dc;
                const finish = () => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    channel.removeEventListener('bufferedamountlow', finish);
                    channel.removeEventListener('close', finish);
                    resolve();
                };
                const timer = setTimeout(finish, 5000);
                channel.addEventListener('bufferedamountlow', finish);
                channel.addEventListener('close', finish);
            });
        }

        async finishReceive() {
            if (this.finished) return;
            if (!this.incoming || !this.expected) return;
            if (this.receivedBytes !== this.expected) {
                this.onConnectionFailed(`文件不完整（${formatBytes(this.receivedBytes)} / ${formatBytes(this.expected)}）`);
                return;
            }
            try {
                const blob = new Blob(this.receivedChunks, { type: this.incoming.type || 'application/octet-stream' });
                const url = URL.createObjectURL(blob);
                const link = document.createElement('a');
                link.href = url;
                link.download = this.incoming.name || 'download';
                document.body.appendChild(link);
                link.click();
                link.remove();
                setTimeout(() => URL.revokeObjectURL(url), 10000);
                this.finished = true;
                this.transferring = false;
                this.transferActive(false);
                this.releaseWakeLock();
                this.sendControl('received');
                this.paint({
                    file: this.incoming,
                    status: '文件已保存到下载目录',
                    hint: '会话已结束，取件码不可重复使用。',
                    buttons: [{ label: '关闭', action: 'close', primary: true }]
                });
            } catch (error) {
                this.onConnectionFailed('保存文件失败：' + error.message);
            }
        }

        onConnectionFailed(reason) {
            this.clearIceTimer();
            this.closePeer();
            this.transferring = false;
            this.transferActive(false);
            this.releaseWakeLock();
            if (this.closed) return;
            if (this.mode === 'send') {
                this.paint({
                    file: this.file,
                    code: this.code,
                    status: reason || '直连失败',
                    warning: '可以改用服务器中转，文件会经服务器加密转发。',
                    buttons: [
                        { label: '改用服务器中转', action: 'fallback', primary: true },
                        { label: '取消', action: 'cancel', danger: true }
                    ]
                });
            } else {
                this.paint({
                    file: this.incoming,
                    status: reason || '直连失败',
                    warning: '请让发送方改用服务器中转，取件码会自动送达。',
                    buttons: [{ label: '取消', action: 'cancel', danger: true }]
                });
            }
        }

        // ---------- 中转回退 ----------

        async fallback() {
            if (this.mode !== 'send' || this.fallbackActive) return;
            this.fallbackActive = true;
            this.clearIceTimer();
            this.closePeer();
            this.transferActive(false);
            this.releaseWakeLock();
            await this.sendControl('relay-pending');
            this.removeOverlay();
            if (typeof this.options.onFallback !== 'function') {
                this.toast('当前页面无法启动服务器中转', 'error');
                this.close({});
                return;
            }
            try {
                await this.options.onFallback(this.file, code => this.sendRelayCode(code));
            } catch (error) {
                this.sendControl('cancel').catch(() => {});
                this.toast('服务器中转启动失败：' + error.message, 'error');
                this.close({});
            }
        }

        async sendRelayCode(code) {
            if (this.closed) return;
            if (!code) {
                await this.sendControl('cancel');
                this.finishRelaySession();
                return;
            }
            await this.sendControl('relay', { code });
            // 信令已经进队列。房间保留一分钟，后台标签页被节流时也能取到；
            // 随后用一个闭包里的码删除，不影响下一次分享。
            this.finishRelaySession();
        }

        // ---------- 状态与清理 ----------

        resetSession() {
            this.closed = false;
            this.finished = false;
            this.started = false;
            this.transferring = false;
            this.fallbackActive = false;
            this.peerJoined = false;
            this.sas = '';
            this.after = 0;
            this.sentBytes = 0;
            this.file = null;
            this.options = {};
            this.receivedChunks = [];
            this.receivedBytes = 0;
            this.expected = null;
            this.incoming = null;
            this.pendingCandidates = [];
            this.remoteDescriptionSet = false;
            this.progressBar = null;
            this.progressStatus = null;
        }

        resetPeer() {
            this.clearIceTimer();
            this.closePeer();
            this.sas = '';
            this.pendingCandidates = [];
            this.remoteDescriptionSet = false;
        }

        closePeer() {
            if (this.dc) {
                try { this.dc.close(); } catch {}
                this.dc = null;
            }
            if (this.pc) {
                try { this.pc.close(); } catch {}
                this.pc = null;
            }
            this.remoteDescriptionSet = false;
        }

        startIceTimer() {
            this.clearIceTimer();
            this.iceTimer = setTimeout(() => {
                this.iceTimer = null;
                if (this.dc && this.dc.readyState === 'open') return;
                this.onConnectionFailed('直连超时，可能受网络或 NAT 限制');
            }, ICE_TIMEOUT_MS);
        }

        clearIceTimer() {
            if (this.iceTimer) {
                clearTimeout(this.iceTimer);
                this.iceTimer = null;
            }
        }

        transferActive(active) {
            if (window.app && typeof window.app === 'object') window.app.transferActive = !!active;
        }

        async requestWakeLock() {
            if (!navigator.wakeLock || this.wakeLock) return;
            try {
                this.wakeLock = await navigator.wakeLock.request('screen');
                this.wakeLock.addEventListener('release', () => { this.wakeLock = null; });
            } catch {}
        }

        releaseWakeLock() {
            if (!this.wakeLock) return;
            try { this.wakeLock.release(); } catch {}
            this.wakeLock = null;
        }

        cancel() {
            if (this.mode === 'receive' && !this.finished && !this.closed) {
                this.sendControl('cancel').catch(() => {});
            }
            this.close({});
        }

        close(options = {}) {
            const { keepRoom = false } = options;
            if (this.closed) {
                this.removeOverlay();
                return;
            }
            this.closed = true;
            this.active = false;
            this.transferring = false;
            this.clearIceTimer();
            this.closePeer();
            this.transferActive(false);
            this.releaseWakeLock();
            if (this.pollController) {
                try { this.pollController.abort(); } catch {}
                this.pollController = null;
            }
            if (!keepRoom && this.code && this.token) {
                request('/api/rtc/room/' + encodeURIComponent(this.code), {
                    method: 'DELETE',
                    token: this.token
                }).catch(() => {});
            }
            this.removeOverlay();
        }

        finishRelaySession() {
            const code = this.code;
            const token = this.token;
            this.closed = true;
            this.active = false;
            this.transferring = false;
            this.clearIceTimer();
            this.closePeer();
            this.transferActive(false);
            this.releaseWakeLock();
            if (this.pollController) {
                try { this.pollController.abort(); } catch {}
                this.pollController = null;
            }
            this.removeOverlay();
            if (code && token) {
                setTimeout(() => {
                    request('/api/rtc/room/' + encodeURIComponent(code), {
                        method: 'DELETE',
                        token
                    }).catch(() => {});
                }, 60000);
            }
        }

        onRoomGone(error) {
            this.clearIceTimer();
            this.closePeer();
            this.transferring = false;
            this.transferActive(false);
            this.releaseWakeLock();
            if (this.pollController) {
                try { this.pollController.abort(); } catch {}
                this.pollController = null;
            }
            if (this.finished) {
                this.closed = true;
                this.active = false;
                return;
            }
            this.closed = true;
            const message = error && error.message ? error.message : '会话已结束';
            if (this.overlay) {
                this.paint({
                    file: this.mode === 'send' ? this.file : this.incoming,
                    status: message,
                    warning: '取件码可能已被使用、过期，或对端已取消。',
                    buttons: [{ label: '关闭', action: 'close', primary: true }]
                });
            }
            this.active = false;
        }

        // ---------- 视图 ----------

        createOverlay(title) {
            this.removeOverlay();
            const overlay = html(`
                <div class="rtc-overlay" role="dialog" aria-modal="true" aria-labelledby="rtcTitle">
                    <div class="rtc-dialog">
                        <h3 id="rtcTitle">${esc(title)}</h3>
                        <div class="rtc-body"></div>
                    </div>
                </div>
            `);
            overlay.addEventListener('keydown', event => {
                if (event.key === 'Escape') {
                    event.preventDefault();
                    this.cancel();
                }
            });
            document.body.append(overlay);
            this.overlay = overlay;
        }

        removeOverlay() {
            if (this.overlay) {
                this.overlay.remove();
                this.overlay = null;
            }
            this.progressBar = null;
            this.progressStatus = null;
        }

        paint(view) {
            if (!this.overlay) return;
            const body = $('.rtc-body', this.overlay);
            if (!body) return;

            const file = view.file
                ? `<p class="rtc-file"><strong>${esc(view.file.name || '文件')}</strong><span>${esc(formatBytes(view.file.size || 0))}</span></p>`
                : '';
            const code = view.code
                ? `<p class="rtc-label">取件码</p><div class="rtc-code">${esc(view.code)}</div>`
                : '';
            const verify = view.verify
                ? `<div class="rtc-verify"><span>确认码</span><strong>${esc(view.verify || '----')}</strong></div>`
                : '';
            const progress = view.progress
                ? '<div class="rtc-progress"><span></span></div>'
                : '';
            const status = view.status
                ? `<p class="rtc-status" role="status" aria-live="polite">${esc(view.status)}</p>`
                : '';
            const hint = view.hint ? `<p class="rtc-hint">${esc(view.hint)}</p>` : '';
            const warning = view.warning ? `<p class="rtc-warning">${esc(view.warning)}</p>` : '';
            const buttons = (view.buttons || []).map(button => {
                const classes = ['btn'];
                if (button.primary) classes.push('btn-primary');
                if (button.danger) classes.push('btn-danger');
                return `<button type="button" class="${classes.join(' ')}" data-action="${esc(button.action)}">${esc(button.label)}</button>`;
            }).join('');

            body.innerHTML = `${file}${code}${verify}${status}${progress}${hint}${warning}<div class="rtc-actions">${buttons}</div>`;
            this.progressBar = progress ? $('.rtc-progress span', body) : null;
            this.progressStatus = progress ? $('.rtc-status', body) : null;

            body.querySelectorAll('[data-action]').forEach(button => {
                button.onclick = () => this.onAction(button.dataset.action);
            });
            const primary = body.querySelector('.btn-primary') || body.querySelector('[data-action="cancel"]');
            if (primary) primary.focus({ preventScroll: true });
        }

        updateProgress(done, total) {
            if (!this.progressBar) return;
            const percent = total ? Math.min(100, Math.round(done / total * 100)) : 0;
            const now = Date.now();
            if (percent < 100 && now - this.lastProgressAt < 120) return;
            this.lastProgressAt = now;
            this.progressBar.style.width = percent + '%';
            if (this.progressStatus) {
                const verb = this.mode === 'send' ? '正在发送' : '正在接收';
                this.progressStatus.textContent = `${verb} ${percent}%（${formatBytes(done)} / ${formatBytes(total)}）`;
            }
        }

        onAction(action) {
            if (action === 'copy') return this.copyCode();
            if (action === 'cancel') return this.cancel();
            if (action === 'fallback') return this.fallback();
            if (action === 'send') return this.startSending();
            if (action === 'close') return this.close({});
        }

        async copyCode() {
            if (!this.code) return;
            const button = this.overlay && this.overlay.querySelector('[data-action="copy"]');
            try {
                await navigator.clipboard.writeText(this.code);
                if (!button) return;
                button.textContent = '已复制';
                setTimeout(() => {
                    if (button.isConnected) button.textContent = '复制取件码';
                }, 2000);
            } catch {
                this.toast('复制失败，请手动输入这 5 位取件码', 'error');
            }
        }

        toast(message, type = '') {
            if (window.app && typeof window.app.showToast === 'function') {
                window.app.showToast(message, type);
            }
        }
    }

    const transfer = new RtcTransfer();
    window.RtcTransfer = transfer;
})(window);
