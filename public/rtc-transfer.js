((window) => {
    'use strict';

    // 二期实时传文件：发送方创建 5 位数字取件码，接收方在超级搜索框输入后
    // 双方通过 WebRTC DataChannel 直连。服务端只转发 SDP/ICE，不接触文件内容。
    //
    // 取舍：
    // · 单文件、单接收方、一次性会话。接收方离开后发送方可以等下一个接收方。
    // · 分片可靠有序，用 bufferedAmount 做背压，避免灌爆 SCTP 缓冲。
    // · 直连失败不自动重试，由发送方选择回退到一期服务器中转。
    // · DTLS 已经保证链路加密；额外显示 4 位确认码，用来发现信令被替换。
    //
    // 吞吐实测：Chrome 下 16 KiB 分片配 1 MiB 发送窗口最快，更大分片或窗口
    // 都会明显变慢；读取提前一片，与发送重叠。接收端可边收边写入选定文件。

    const CHUNK_SIZE = 16 * 1024;
    const CHUNK_SIZE_MIN = 1024;
    const BUFFER_HIGH = 1024 * 1024;
    const BUFFER_LOW = 256 * 1024;
    const BUFFER_TIMEOUT_MS = 30000;
    const PREFETCH_DEPTH = 1;
    const STATS_INTERVAL_MS = 1000;
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

    function supportsSavePicker() {
        return typeof window.showSaveFilePicker === 'function' && window.isSecureContext !== false;
    }

    function suggestFileName(name) {
        return String(name || '文件')
            .replace(/[\u0000-\u001f\u007f\\/:*?"<>|]/g, '_')
            .trim()
            .slice(0, 120) || '文件';
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
            this.fallbackPending = false;
            this.peerJoined = false;
            this.sas = '';

            this.receivedChunks = [];
            this.receivedBytes = 0;
            this.expected = null;
            this.incoming = null;
            this.sentBytes = 0;
            this.progressBar = null;
            this.progressStatus = null;
            this.progressStats = null;
            this.wakeLock = null;

            // 接收侧：可选流式落盘。未选择目标时仍走内存 Blob 回退。
            this.streaming = false;
            this.writable = null;
            this.writeChain = Promise.resolve();
            this.streamWriteError = null;
            this.savePickerPending = false;
            this.pendingDone = false;
            // 链路诊断：候选对类型、RTT 与按秒采样的吞吐。
            this.statsTimer = null;
            this.statsText = '';
            this.statsSample = null;

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
                save: true,
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
                // 发送方关闭 DataChannel 也会触发 onclose/onConnectionFailed。
                // 记住中转已在路上，避免断线错误把「正在改用中转」覆盖掉。
                this.fallbackPending = true;
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
                        save: true,
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
            this.stopStats();
            this.releaseWritable();
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
                bundlePolicy: 'max-bundle',
                // 提前收集少量候选，缩短拿到 offer 之后的建连时间。
                iceCandidatePoolSize: 2
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
                if (this.closed || this.finished || this.fallbackPending) return;
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
                    save: true,
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
                    // 用户可能已经在等待直连时选好保存位置，这里只重置计数，
                    // 不能中断已经打开的写入目标。
                    this.receivedChunks = [];
                    this.receivedBytes = 0;
                    this.streamWriteError = null;
                    this.pendingDone = false;
                    this.incoming = {
                        name: String(message.name || '文件'),
                        size: Number(message.size) || 0,
                        type: String(message.mime || 'application/octet-stream')
                    };
                    this.expected = this.incoming.size;
                    this.transferring = true;
                    this.lastProgressAt = 0;
                    this.transferActive(true);
                    this.requestWakeLock();
                    this.paint({
                        file: this.incoming,
                        status: '正在接收文件…',
                        warning: '传输期间请不要关闭或刷新页面。',
                        progress: true,
                        save: true,
                        buttons: [{ label: '取消', action: 'cancel', danger: true }]
                    });
                    this.startStats();
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
            if (this.streaming) this.writeChunk(chunk);
            else this.receivedChunks.push(chunk);
            this.updateProgress(this.receivedBytes, this.expected);
        }

        resolveChunkSize() {
            const maxMessageSize = this.pc && this.pc.sctp && this.pc.sctp.maxMessageSize;
            if (!Number.isFinite(maxMessageSize) || maxMessageSize <= 0) return CHUNK_SIZE;
            return Math.max(CHUNK_SIZE_MIN, Math.min(CHUNK_SIZE, Math.floor(maxMessageSize)));
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
            this.startStats();
            try {
                // 消息类型用 type，MIME 用 mime。同一对象里不能写两个 type，
                // 否则后一个会覆盖 meta，接收端会把它当成未知消息丢掉。
                this.dc.send(JSON.stringify({
                    type: 'meta',
                    name: this.file.name,
                    size: this.file.size,
                    mime: this.file.type || 'application/octet-stream'
                }));

                const chunkSize = this.resolveChunkSize();
                const total = this.file.size;
                const queue = [];
                let nextOffset = 0;
                const enqueue = () => {
                    if (nextOffset >= total) return;
                    const start = nextOffset;
                    const end = Math.min(start + chunkSize, total);
                    nextOffset = end;
                    // 读取 Promise 先排队，网络发送与下一片读取重叠。
                    queue.push(this.file.slice(start, end).arrayBuffer());
                };
                for (let index = 0; index < PREFETCH_DEPTH; index++) enqueue();

                while (queue.length) {
                    if (this.closed) throw new DOMException('已取消', 'AbortError');
                    await this.waitForBuffer();
                    if (!this.dc || this.dc.readyState !== 'open') throw new Error('连接已断开');
                    const buffer = await queue.shift();
                    enqueue();
                    this.dc.send(buffer);
                    this.sentBytes += buffer.byteLength;
                    this.updateProgress(this.sentBytes, total);
                }

                this.dc.send(JSON.stringify({ type: 'done' }));
                this.finished = true;
                this.transferring = false;
                this.transferActive(false);
                this.releaseWakeLock();
                this.stopStats();
                this.sentBytes = total;
                this.paint({
                    file: this.file,
                    status: '已发送完成，等待接收方保存…',
                    hint: '接收方保存后会自动结束会话。',
                    buttons: [{ label: '关闭', action: 'close' }]
                });
            } catch (error) {
                if (error.name === 'AbortError') return;
                console.warn('[RTC] 发送循环失败', error.message);
                this.onConnectionFailed(error.message || '发送失败');
            }
        }

        async waitForBuffer() {
            if (!this.dc || this.dc.bufferedAmount < BUFFER_HIGH) return;
            await new Promise(resolve => {
                let settled = false;
                let pollTimer = null;
                const channel = this.dc;
                const finish = () => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timeoutTimer);
                    clearInterval(pollTimer);
                    channel.removeEventListener('bufferedamountlow', finish);
                    channel.removeEventListener('close', finish);
                    resolve();
                };
                const check = () => {
                    // 监听器挂上时缓冲可能已经降到阈值以下，浏览器不会再补发
                    // bufferedamountlow；少这一次复查就会一直等到超时。
                    if (!channel || channel.readyState !== 'open' || channel.bufferedAmount <= BUFFER_LOW) finish();
                };
                channel.addEventListener('bufferedamountlow', finish);
                channel.addEventListener('close', finish);
                // 慢链路排空 768 KiB 可能超过 5 秒，超时上调到 30 秒。
                const timeoutTimer = setTimeout(finish, BUFFER_TIMEOUT_MS);
                pollTimer = setInterval(check, 50);
                check();
            });
        }

        writeChunk(chunk) {
            if (!this.writable) {
                this.receivedChunks.push(chunk);
                return;
            }
            const writable = this.writable;
            // 写入串行排队，保证分片顺序与 DataChannel 一致。
            this.writeChain = this.writeChain
                .then(() => writable.write(chunk))
                .catch(error => this.onStreamWriteFailed(error));
        }

        onStreamWriteFailed(error) {
            if (!this.writable || this.streamWriteError) return;
            this.streamWriteError = error || new Error('写入失败');
            this.onConnectionFailed('保存文件失败：' + this.streamWriteError.message);
        }

        releaseWritable() {
            const writable = this.writable;
            this.writable = null;
            this.streaming = false;
            this.writeChain = Promise.resolve();
            if (writable) writable.abort().catch(() => {});
        }

        async chooseSaveTarget() {
            if (this.streaming || this.savePickerPending || this.finished) return;
            if (!supportsSavePicker()) {
                this.toast('当前浏览器不支持选择保存位置，将保存到下载目录', 'error');
                return;
            }
            this.savePickerPending = true;
            try {
                const handle = await window.showSaveFilePicker({
                    suggestedName: suggestFileName(this.incoming && this.incoming.name)
                });
                const writable = await handle.createWritable();
                if (this.closed) {
                    await writable.abort().catch(() => {});
                    return;
                }
                this.writable = writable;
                this.streaming = true;
                this.streamWriteError = null;
                const buffered = this.receivedChunks;
                this.receivedChunks = [];
                // 已经收到的分片先落盘，之后到达的分片继续排队写入。
                this.writeChain = this.writeChain
                    .then(async () => {
                        for (const chunk of buffered) await writable.write(chunk);
                    })
                    .catch(error => this.onStreamWriteFailed(error));
                this.toast('已选择保存位置，后续分片会直接写入文件');
                const button = this.overlay && this.overlay.querySelector('[data-action="save-target"]');
                if (button) {
                    button.disabled = true;
                    button.textContent = '正在写入所选文件';
                }
            } catch (error) {
                if (error.name !== 'AbortError') this.toast('无法写入所选位置：' + error.message, 'error');
            } finally {
                this.savePickerPending = false;
                if (this.pendingDone) {
                    this.pendingDone = false;
                    await this.finishReceive();
                }
            }
        }

        async finishReceive() {
            if (this.finished || this.closed) return;
            if (!this.incoming || !this.expected) return;
            if (this.receivedBytes !== this.expected) {
                this.onConnectionFailed(`文件不完整（${formatBytes(this.receivedBytes)} / ${formatBytes(this.expected)}）`);
                return;
            }
            if (this.savePickerPending) {
                // 保存位置对话框还开着，等用户选完再决定走流式还是下载。
                this.pendingDone = true;
                return;
            }
            if (this.streaming) {
                await this.finishStreaming();
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
                this.stopStats();
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

        async finishStreaming() {
            try {
                await this.writeChain;
                if (this.streamWriteError) throw this.streamWriteError;
                const writable = this.writable;
                if (!writable) throw new Error('写入目标已关闭');
                await writable.close();
                this.writable = null;
                this.streaming = false;
                this.finished = true;
                this.transferring = false;
                this.transferActive(false);
                this.releaseWakeLock();
                this.stopStats();
                this.sendControl('received');
                this.paint({
                    file: this.incoming,
                    status: '文件已保存到所选位置',
                    hint: '会话已结束，取件码不可重复使用。',
                    buttons: [{ label: '关闭', action: 'close', primary: true }]
                });
            } catch (error) {
                this.onConnectionFailed('保存文件失败：' + error.message);
            }
        }

        onConnectionFailed(reason) {
            this.clearIceTimer();
            this.stopStats();
            this.releaseWritable();
            this.closePeer();
            this.transferring = false;
            this.transferActive(false);
            this.releaseWakeLock();
            if (this.closed) return;
            // 接收方已经收到 relay-pending：断线是发送方主动切中转造成的，
            // 不要把等待取件码的界面改成错误。
            if (this.mode === 'receive' && this.fallbackPending) return;
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
            this.transferActive(false);
            this.releaseWakeLock();
            // 先让接收方进入「等待中转」状态，再断开 DataChannel。
            // 反过来做会让接收端先收到断线事件，界面上闪一下错误。
            await this.sendControl('relay-pending');
            this.closePeer();
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
            this.stopStats();
            this.releaseWritable();
            this.closed = false;
            this.finished = false;
            this.started = false;
            this.transferring = false;
            this.fallbackActive = false;
            this.fallbackPending = false;
            this.peerJoined = false;
            this.sas = '';
            this.after = 0;
            this.sentBytes = 0;
            this.file = null;
            this.options = {};
            this.streamWriteError = null;
            this.pendingDone = false;
            this.receivedChunks = [];
            this.receivedBytes = 0;
            this.expected = null;
            this.incoming = null;
            this.pendingCandidates = [];
            this.remoteDescriptionSet = false;
            this.progressBar = null;
            this.progressStatus = null;
            this.progressStats = null;
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
            this.stopStats();
            this.releaseWritable();
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
            this.stopStats();
            this.releaseWritable();
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
            this.stopStats();
            this.releaseWritable();
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
            this.progressStats = null;
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
                ? '<div class="rtc-progress"><span></span></div><p class="rtc-stats" aria-hidden="true"></p>'
                : '';
            const status = view.status
                ? `<p class="rtc-status" role="status" aria-live="polite">${esc(view.status)}</p>`
                : '';
            const hint = view.hint ? `<p class="rtc-hint">${esc(view.hint)}</p>` : '';
            const warning = view.warning ? `<p class="rtc-warning">${esc(view.warning)}</p>` : '';
            const actions = [...(view.buttons || [])];
            if (view.save && supportsSavePicker() && !this.streaming && !this.finished) {
                actions.unshift({ label: '保存到磁盘', action: 'save-target' });
            }
            const buttons = actions.map(button => {
                const classes = ['btn'];
                if (button.primary) classes.push('btn-primary');
                if (button.danger) classes.push('btn-danger');
                return `<button type="button" class="${classes.join(' ')}" data-action="${esc(button.action)}">${esc(button.label)}</button>`;
            }).join('');

            body.innerHTML = `${file}${code}${verify}${status}${progress}${hint}${warning}<div class="rtc-actions">${buttons}</div>`;
            this.progressBar = progress ? $('.rtc-progress span', body) : null;
            this.progressStatus = progress ? $('.rtc-status', body) : null;
            this.progressStats = progress ? $('.rtc-stats', body) : null;
            this.updateStatsText();

            body.querySelectorAll('[data-action]').forEach(button => {
                button.onclick = () => this.onAction(button.dataset.action);
            });
            const primary = body.querySelector('.btn-primary') || body.querySelector('[data-action="cancel"]');
            if (primary) primary.focus({ preventScroll: true });
        }

        startStats() {
            this.stopStats();
            if (!this.pc) return;
            this.sampleStats();
            this.statsTimer = setInterval(() => this.sampleStats(), STATS_INTERVAL_MS);
        }

        stopStats() {
            if (this.statsTimer) {
                clearInterval(this.statsTimer);
                this.statsTimer = null;
            }
            this.statsSample = null;
            this.statsText = '';
            this.updateStatsText();
        }

        async sampleStats() {
            if (!this.pc || this.closed) {
                this.stopStats();
                return;
            }
            let report;
            try { report = await this.pc.getStats(); }
            catch { return; }
            let pair = null;
            let transport = null;
            report.forEach(stat => {
                if (stat.type === 'transport' && stat.selectedCandidatePairId) transport = stat;
            });
            if (transport) pair = report.get(transport.selectedCandidatePairId);
            if (!pair) {
                report.forEach(stat => {
                    if (stat.type === 'candidate-pair' && stat.state === 'succeeded' && (stat.nominated || !pair)) pair = stat;
                });
            }
            if (!pair) return;

            const local = report.get(pair.localCandidateId);
            const remote = report.get(pair.remoteCandidateId);
            const types = [local && local.candidateType, remote && remote.candidateType];
            const kind = types.includes('relay') ? 'TURN 中继'
                : types.includes('srflx') || types.includes('prflx') ? 'NAT 打洞'
                    : types.includes('host') ? '局域网直连' : '';
            const bytes = this.mode === 'send' ? pair.bytesSent : pair.bytesReceived;
            const now = performance.now();
            let rate = '';
            if (this.statsSample && Number.isFinite(bytes)) {
                const seconds = (now - this.statsSample.at) / 1000;
                const delta = bytes - this.statsSample.bytes;
                if (seconds > 0 && delta >= 0) rate = formatBytes(delta / seconds) + '/s';
            }
            if (Number.isFinite(bytes)) this.statsSample = { at: now, bytes };
            const parts = [];
            if (kind) parts.push(kind);
            if (Number.isFinite(pair.currentRoundTripTime)) {
                parts.push('RTT ' + Math.round(pair.currentRoundTripTime * 1000) + ' ms');
            }
            if (rate) parts.push(rate);
            this.statsText = parts.join(' · ');
            this.updateStatsText();
        }

        updateStatsText() {
            if (!this.progressStats) return;
            if (this.progressStats.textContent === this.statsText) return;
            this.progressStats.textContent = this.statsText;
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
            if (action === 'save-target') return this.chooseSaveTarget();
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
