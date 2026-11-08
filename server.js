const express = require('express');
const compression = require('compression');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const http = require('http');
const bcrypt = require('bcrypt');

// ⚠️ 必须写成 './server-config/index.js'（显式带 index.js），不能写 './server-config'。
//
// Node 解析 `require('./server-config')` 的顺序是 `.js` → `.json` → `.node` → **目录**，
// 所以安装目录根下的 server-config.json（用户配置，由后台自签开关写出）会**遮蔽**
// server-config/ 目录：index.js 一行都不执行，defaults 不被合并，rootDir 也不会被
// 赋值（它不在 defaults.js 里，是 index.js 单独加的），于是服务启动即崩。
//
// 写成显式路径后，加载的永远是目录模块，用户那份 json 仍由 index.js 的
// loadFromConfigFile() 读出并覆盖到 defaults 之上——这才是它本来的设计语义。
// 1.6.10 曾试图用「写全配置」绕开遮蔽，但 rootDir 不在 defaults 里、补不出来，
// 于是同一个故障复发；让遮蔽不发生才是正解。
const config = require('./server-config/index.js');

// 判定「这份配置不是被遮蔽后的残片」所需的段。
//
// 刻意硬编码而不从 server-config/defaults.js 取：那份 defaults 是**用户配置之外**的
// 兜底，列在这里等于「拿到完整配置时必须具备的段」；若将来 defaults 增删段，
// 这个清单要跟着人工过一遍——这是有意的，避免把「defaults 里有什么」
// 和「运行时必须有什么」两件事绑在一起。
//
// 顺序按最早被使用排：rootDir 在文件顶部就被 path.join 用到，其后是 paths。
const REQUIRED_CONFIG_SECTIONS = ['rootDir', 'server', 'paths', 'security'];

// defaults 兜底用的段清单见下方 REQUIRED_CONFIG_SECTIONS；此处不再单独 require defaults
// （1.6.10 曾用它补齐配置，那条路已废弃——rootDir 不在 defaults 里，补不出来）。

// ⚠️ 为什么校验必须在这里，而不能放进 server-config/index.js：
//
// Node 解析 `require('./server-config')` 的顺序是 `.js` → `.json` → `.node`
// → **目录**。所以 ~/pabu/server-config.json 一旦存在，加载的就是它，
// `server-config/index.js` **一行都不会执行**——校验写在那边等于死代码。
// 这里 require 完是全项目第一个能同时看到「配置对象」和「目录是否存在」的
// 位置，也是唯一能在 `path.join(config.rootDir, ...)` 之前拦下来的地方。
//
// 失败模式（实测）：一份只写了 `{"security":{"selfSignedCert":false}}` 的残片
// 让 config 少了 rootDir/server/paths 等键，第一个用到它的 server.js:219
// `path.join(config.rootDir, 'config.json')` 收到 undefined，抛出的却是
// `ERR_INVALID_ARG_TYPE: The "path" argument must be of type string`——
// 指向 path.join，既不提配置文件，也不提同名目录被遮蔽，排查要绕三层。
assertConfigUsable(config);

const app = express();
let server;

/**
 * 校验 require('./server-config') 拿到的是不是一份可用的服务配置。
 *
 * 唯一能判定的失效模式是「同名 json 遮蔽了 server-config/ 目录」：
 * 那种情况下 require 返回的是用户的 `server-config.json` 原文，
 * 只有用户写过的那几个键，defaults 里的其余段（rootDir/server/paths/app/webdav）
 * 一个都没有。它必须在这里报，且要说人话——失败链路见上方 require 处的注释。
 *
 * 判据用 `rootDir` 是否存在，而不是比对 defaults 的完整键集：
 * `server-config/index.js` 正常跑完会无条件补上 rootDir（它由 __dirname 推导），
 * 而任何用户 json 都给不出这个字段——所以它的缺失是遮蔽的充分证据。
 *
 * 目录缺失（用户从未写过 server-config.json）时 require 的就是 index.js，
 * 这一层不会触发；此处的 if 只是万一 index.js 被移走时的兜底文案。
 *
 * @throws {Error} 指向 server-config.json 本身，而非某个下游的 path.join
 */
function assertConfigUsable(loaded) {
    // 判据是两个而不是一个：rootDir 与 validate。
    //
    // 只查 rootDir 的话，用户手写一份带 "rootDir": "..." 的 json 就能绕过——
    // 实测那样会放行，然后在更下游炸成 `config.validate is not a function`
    // （server.js 末尾会调它），正是本函数要消灭的那类指不到真因的错误。
    // validate 只有 server-config/index.js 会挂，用户 json 给不出来，
    // 而 rootDir 在残片状态下根本不可能是字符串。两个合起来才是充分证据。
    if (loaded && typeof loaded.rootDir === 'string' && typeof loaded.validate === 'function') {
        return;
    }

    const userFile = path.join(__dirname, 'server-config.json');
    const present = fsSync.existsSync(userFile);
    const missing = REQUIRED_CONFIG_SECTIONS.filter((key) => !loaded || !(key in loaded));
    if (loaded && typeof loaded.validate !== 'function' && missing.length === 0) {
        missing.push('validate()');
    }

    throw new Error(
        '服务配置加载失败：' + (present
            ? `${userFile} 遮蔽了 server-config/ 目录，Node 优先加载了它，` +
              '但它不是一个完整的配置对象（缺少 ' + missing.join(', ') + '）。\n' +
              '  Node 的解析顺序是 .js → .json → 目录，server-config.json 一旦存在就赢。\n' +
              '  · 你本意是用默认配置 → 备份后删除：' +
              `cp '${userFile}' '${userFile}.bak' && sudo rm '${userFile}'\n` +
              '  · 你要改配置 → 参考 server-config.example.json 写完整后再启用'
            : 'server-config/ 目录缺失或无法加载，请重新安装程序文件'
        )
    );
}

// ========== Paste 分享功能 ==========
const pasteStorage = new Map();
// 结构: { code: { content, pin, expiresAt, attempts } }

// 有效期白名单：键为分钟数，值为毫秒。只接受这些档位，未知值回落到 5 分钟。
// 用 Object.create(null) 断开原型链，避免 ttl="constructor" 之类取到原型属性，
// 把 expiresAt 变成 NaN 或字符串，导致条目永不过期、永不被清理。
const PASTE_TTL_OPTIONS = Object.assign(Object.create(null), {
    5: 5 * 60 * 1000,
    30: 30 * 60 * 1000,
    1440: 24 * 60 * 60 * 1000,
    10080: 7 * 24 * 60 * 60 * 1000
});
const PASTE_DEFAULT_TTL_MINUTES = 5;

// 只接受白名单自身的键；数字以外的键（如 "5"）也视为非法，避免类型混淆
function resolvePasteTtlMinutes(ttl) {
    if (typeof ttl !== 'number' || !Number.isInteger(ttl)) return PASTE_DEFAULT_TTL_MINUTES;
    return Object.hasOwn(PASTE_TTL_OPTIONS, ttl) ? ttl : PASTE_DEFAULT_TTL_MINUTES;
}

// 词表用于生成易记的分享码
const ADJECTIVES = [
    'happy', 'sunny', 'cool', 'swift', 'brave', 'calm', 'eager', 'fair', 'gentle', 'kind',
    'lively', 'merry', 'nice', 'proud', 'quick', 'smart', 'warm', 'wise', 'bold', 'bright',
    'clean', 'clear', 'crisp', 'deep', 'fine', 'fresh', 'glad', 'good', 'grand', 'great',
    'keen', 'light', 'neat', 'pure', 'rich', 'safe', 'sharp', 'soft', 'strong', 'sweet',
    'tall', 'true', 'vast', 'vivid', 'wild', 'young', 'zesty', 'agile', 'fancy', 'golden',
    'handy', 'ideal', 'jolly', 'lucky', 'magic', 'noble', 'peaceful', 'rapid', 'royal', 'silent',
    'simple', 'smooth', 'solid', 'stable', 'steady', 'super', 'tender', 'tiny', 'ultra', 'unique',
    'useful', 'valid', 'vital', 'witty', 'zealous', 'azure', 'cosmic', 'divine', 'epic', 'fiery',
    'frozen', 'humble', 'lunar', 'mighty', 'mystic', 'polar', 'primal', 'radiant', 'rustic', 'serene',
    'silver', 'sonic', 'stellar', 'stormy', 'sunset', 'thunder', 'timber', 'turbo', 'velvet', 'vintage'
];

const NOUNS = [
    'tiger', 'eagle', 'wolf', 'bear', 'fox', 'hawk', 'lion', 'deer', 'swan', 'dove',
    'oak', 'pine', 'maple', 'cedar', 'birch', 'willow', 'palm', 'fern', 'rose', 'lily',
    'river', 'lake', 'ocean', 'stream', 'wave', 'cloud', 'rain', 'snow', 'wind', 'storm',
    'star', 'moon', 'sun', 'sky', 'dawn', 'dusk', 'night', 'day', 'light', 'shadow',
    'stone', 'rock', 'hill', 'peak', 'cliff', 'cave', 'sand', 'dust', 'flame', 'spark',
    'dragon', 'phoenix', 'griffin', 'raven', 'falcon', 'owl', 'crane', 'heron', 'finch', 'lark',
    'coral', 'pearl', 'jade', 'ruby', 'amber', 'crystal', 'diamond', 'emerald', 'onyx', 'opal',
    'bridge', 'tower', 'castle', 'temple', 'garden', 'forest', 'meadow', 'valley', 'island', 'harbor',
    'arrow', 'blade', 'crown', 'drum', 'flute', 'harp', 'horn', 'lyre', 'shield', 'sword',
    'atlas', 'bolt', 'comet', 'delta', 'echo', 'frost', 'glow', 'haze', 'iris', 'jazz',
    'karma', 'lotus', 'metro', 'nexus', 'orbit', 'pulse', 'quest', 'ridge', 'surge', 'tide',
    'unity', 'vortex', 'whisper', 'zenith', 'zephyr', 'anchor', 'beacon', 'cipher', 'drift', 'ember',
    'flare', 'glider', 'horizon', 'ignite', 'jungle', 'kindle', 'lagoon', 'mirage', 'nebula', 'oasis',
    'prism', 'quartz', 'rapids', 'sage', 'terra', 'umbra', 'vertex', 'wraith', 'yacht', 'zero',
    'alpha', 'beta', 'gamma', 'sigma', 'omega', 'nova', 'pixel', 'quasar', 'realm', 'spirit',
    'thunder', 'titan', 'vapor', 'vector', 'voyage', 'wander', 'wonder', 'xerox', 'yonder', 'zodiac',
    'breeze', 'canyon', 'delta', 'epoch', 'fiber', 'grain', 'haven', 'inlet', 'jewel', 'knot',
    'ledge', 'manor', 'night', 'olive', 'petal', 'quill', 'reef', 'shell', 'thorn', 'bloom',
    'coast', 'dune', 'field', 'grove', 'marsh', 'plain', 'shore', 'trail', 'woods', 'brook'
];

function generatePasteCode() {
    // 中国人常见的简短英文单词
    const words = [
        // 动物
        'cat', 'dog', 'bird', 'fish', 'bear', 'lion', 'tiger', 'panda', 'fox', 'wolf',
        'duck', 'frog', 'deer', 'rabbit', 'mouse', 'horse', 'sheep', 'pig', 'cow', 'bee',
        // 自然
        'sun', 'moon', 'star', 'sky', 'rain', 'snow', 'wind', 'fire', 'ice', 'sea',
        'lake', 'river', 'hill', 'rock', 'tree', 'leaf', 'rose', 'lily', 'grass', 'cloud',
        // 食物
        'apple', 'orange', 'grape', 'peach', 'mango', 'lemon', 'berry', 'candy', 'cake', 'pizza',
        'bread', 'rice', 'noodle', 'milk', 'juice', 'tea', 'coffee', 'honey', 'sugar', 'salt',
        // 颜色
        'red', 'blue', 'green', 'pink', 'gold', 'silver', 'black', 'white', 'gray', 'purple',
        // 形容词
        'happy', 'lucky', 'cool', 'nice', 'good', 'sweet', 'smart', 'fast', 'big', 'little',
        'hot', 'cold', 'new', 'old', 'soft', 'warm', 'bright', 'fresh', 'quiet', 'calm',
        // 名词
        'love', 'game', 'music', 'book', 'king', 'queen', 'baby', 'angel', 'dream', 'hope',
        'time', 'day', 'night', 'home', 'door', 'key', 'box', 'gift', 'card', 'note',
        'phone', 'photo', 'video', 'song', 'dance', 'smile', 'heart', 'magic', 'power', 'peace'
    ];
    const word = words[Math.floor(Math.random() * words.length)];
    const num = Math.floor(Math.random() * 900) + 100; // 100-999
    const code = `${word}-${num}`;

    // 确保唯一性
    if (pasteStorage.has(code)) {
        return generatePasteCode();
    }
    return code;
}

function isPasteCodeFormat(str) {
    // 匹配 单词-3位数字 格式 (7-10位)
    return /^[a-z]{2,6}-\d{3}$/.test(str);
}

// 清理过期分享
function cleanExpiredPastes() {
    const now = Date.now();
    for (const [code, data] of pasteStorage.entries()) {
        if (now > data.expiresAt) {
            pasteStorage.delete(code);
        }
    }
}

// 分享限流：取码与创建是两个独立入口，用不同 key 分别计数，
// 避免互相消耗配额
const pasteRateLimitMap = new Map();
const PASTE_CODE_LIMIT = 10;     // 每小时取码次数
const PASTE_CREATE_LIMIT = 20;   // 每小时创建次数
const PASTE_GET_LIMIT = 30;      // 每小时读取次数
const PASTE_RATE_WINDOW = 3600000; // 1小时

// 分享全局容量上限：限流按 IP 计数，多个 IP 仍可能共同堆高内存
const PASTE_MAX_ENTRIES = 500;
const PASTE_MAX_BYTES = 50 * 1024 * 1024;

// 纯函数形式：store 与 now 由调用方传入，便于注入时钟做确定性测试
function consumeRateLimit(store, key, now, windowMs, limit) {
    const record = store.get(key);
    if (!record || now - record.start > windowMs) {
        store.set(key, { start: now, count: 1 });
        return { allowed: true, remaining: limit - 1, resetAt: now + windowMs };
    }
    record.count++;
    store.set(key, record);
    return {
        allowed: record.count <= limit,
        remaining: Math.max(0, limit - record.count),
        resetAt: record.start + windowMs
    };
}

function sweepRateLimitStore(store, now, windowMs) {
    for (const [key, record] of store.entries()) {
        if (now - record.start > windowMs) store.delete(key);
    }
}

// 匿名首页与会话查询使用独立限流。
// 这两条软门在无会话时每次都会跑一次 bcrypt 比对，实测伪造 X-Admin-Password
// 可把单请求从约 7ms 抬到 63ms（约 9 倍 CPU）且无需任何认证。
// 单独计数而不是复用 rateLimit：首页匿名加载是正常流量，若与登录共用一个桶，
// 正常访问就能把登录的防爆破预算耗光。阈值放宽到 120 次/分钟。
const publicReadLimitMap = new Map();
const PUBLIC_READ_WINDOW = 60000;
const PUBLIC_READ_MAX = 120;

function publicReadLimit(req, res, next) {
    const ip = resolveClientIp(req);
    const { allowed } = consumeRateLimit(publicReadLimitMap, ip, Date.now(), PUBLIC_READ_WINDOW, PUBLIC_READ_MAX);
    if (!allowed) {
        return res.status(429).json({ error: '请求过于频繁，请稍后再试' });
    }
    next();
}

function isOverPasteCapacity(count, totalBytes) {
    return count >= PASTE_MAX_ENTRIES || totalBytes >= PASTE_MAX_BYTES;
}

// 限流用的客户端标识。已开启 trust proxy，req.ip 即为反代回填的真实地址；
// 兜底取 socket 地址仅用于完全没有 req.ip 的极端情况。
function resolveClientIp(req) {
    return req.ip || (req.connection && req.connection.remoteAddress) || 'unknown';
}

// 当前已占用的字节数：内容均为密文 base64，字符数即可近似
function pasteStorageBytes() {
    let total = 0;
    for (const data of pasteStorage.values()) {
        total += data.content.length;
    }
    return total;
}



const CONFIG_FILE = path.join(config.rootDir, 'config.json');
const PASSWORD_FILE = config.security.adminPasswordFile;
const { SessionStore, readCookie, ACCEPT_CH, ENV_CHANGED_CODE, ENV_CHANGED_MESSAGE } = require('./lib/session');
const { openDatabase } = require('./lib/db');
const { createNavigation } = require('./lib/navigation');
const { createSyncStore } = require('./lib/sync-store');
const { createSqliteBackend } = require('./lib/session-sqlite');
let navigation, syncStore, db, sessionStore;
let passwordChanging = false;
let authGeneration = 0;
let activeAdminWrites = 0;

// 禁用 X-Powered-By 头
app.disable('x-powered-by');

// 信任反代写入的 X-Forwarded-For，使限流能拿到真实客户端 IP。
// 1 表示只信任最右侧一跳。该跳正是 nginx 用 proxy_add_x_forwarded_for
// 追加 $remote_addr 的位置，客户端自带的 XFF 会被完全丢弃。
// 前提是端口不对外暴露：若能绕过 nginx 直连，客户端可往 XFF 末尾追加任意
// IP 换取新限流桶（实测可无限轮换），此时 1 与 true 都不安全。真正生效的
// 边界是网络层，不是这个取值。
app.set('trust proxy', 1);

// Express 4 不捕获 async 处理函数抛出的异常，这类异常会变成 unhandledRejection
// 并终止进程。任何未认证请求都能触发的解析路径（如 Cookie 解码）都可能打挂服务，
// 因此在这里兜底：记日志、继续存活。真正的请求级错误仍由下面的错误处理中间件负责。
process.on('unhandledRejection', (reason) => {
    console.error('[Server] 未处理的 Promise 拒绝:', reason && reason.message ? reason.message : reason);
});

app.use(
    ['/api/admin/navigation', '/api/admin/default-homepage', '/api/sync/space/create', '/api/sync/config'],
    express.json({ limit: '1100kb' })
);
app.use(express.json());
app.use(compression({ threshold: 1024 }));

// 全局错误处理：统一返回 JSON，并屏蔽 Express 默认处理器会回显的
// err.stack（其中包含 node_modules 路径与服务器绝对目录）。
// 必须紧跟 body-parser 之后，否则捕获不到 PayloadTooLargeError。
app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) {
        console.error(`[Server] ${req.method} ${req.path} 处理失败:`, err.message);
        return res.status(status).json({ error: '服务器内部错误' });
    }
    if (status === 413) return res.status(413).json({ error: '内容过大' });
    res.status(status).json({ error: '请求无效' });
});

// 安全头 (必须在静态文件之前)
app.use((req, res, next) => {
    res.header('X-Content-Type-Options', 'nosniff');
    res.header('X-Frame-Options', 'SAMEORIGIN');
    res.header('X-XSS-Protection', '1; mode=block');
    res.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    // img-src 与 service.js 的 safeAvatarUrl 是同一份白名单的浏览器侧兜底：
    // 时间线上 X 的头像来自 pbs.twimg.com，除此之外不允许外站图片被加载。
    res.header('Content-Security-Policy',
        "script-src 'self' 'unsafe-inline'; img-src 'self' data: ");

    // CORS
    const origin = req.headers.origin;
    if (!origin || origin === `http://${config.server.host}:${config.server.port}`) {
        res.header('Access-Control-Allow-Origin', origin || '*');
    }
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Password');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

app.use('/api', (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)
        || ['/p', '/p/code'].includes(req.path) || req.path.startsWith('/p/')) return next();
    const origin = req.headers.origin;
    const expected = `${req.protocol}://${req.get('host')}`;
    if (req.headers['x-pabu-request'] !== '1'
        || (origin && origin !== expected)
        || req.headers['sec-fetch-site'] === 'cross-site') {
        return res.status(403).json({ error: '请求来源校验失败，请刷新页面后重试' });
    }
    next();
});

const publicIndex = path.join(config.rootDir, 'public', 'index.html');
app.get(['/admin', '/admin/'], (req, res) => res.sendFile(publicIndex));

app.use(express.static(path.join(config.rootDir, 'public'), {
    index: 'index.html',
    extensions: ['html', 'htm']
}));

const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60000; // 1分钟
const RATE_LIMIT_MAX = 30; // 最多30次

function rateLimit(req, res, next) {
    const ip = req.ip || req.connection.remoteAddress;
    const now = Date.now();
    const key = ip + ':auth';

    let record = rateLimitMap.get(key);
    if (!record || now - record.start > RATE_LIMIT_WINDOW) {
        record = { start: now, count: 0 };
    }
    record.count++;
    rateLimitMap.set(key, record);

    if (record.count > RATE_LIMIT_MAX) {
        return res.status(429).json({ error: '请求过于频繁，请稍后再试' });
    }
    next();
}

// ========== 登录防爆破 ==========
//
// 本项目只有一个管理密码、没有账户体系，因此没有「锁账号、输密码解锁」这条路。
// 能做的只有两件事，各管一层：
//
//   第 1 层 失败锁定（主力）：同一 IP 连续 LOGIN_FAIL_MAX 次密码错误即锁该 IP
//                          LOGIN_FAIL_WINDOW。锁定期内直接 429，**不跑 bcrypt**——
//                          攻击者每个 IP 只消耗 LOGIN_FAIL_MAX 次密码比对，
//                          之后边际成本趋近于零，堆再多 IP 也只是自己更慢。
//   第 2 层 总量封顶（兜底）：见 globalLoginLimit，防「大量 IP 各打一次」
//                          这一种不触发锁定的打法。
//
// 三层的执行顺序有讲究：失败锁定必须排在总量封顶**之前**。若总量阈值不大于
// 单 IP 锁定阈值（第 N 次错误），总量桶会先触发，单 IP 锁定永远走不到，
// 锁定功能形同虚设，而且「换一台设备登录」也会被总量桶挡下——
// 那正是全局桶唯一的代价，不该由正常用户先吃到。
const LOGIN_FAIL_WINDOW = 30 * 60000;  // 30 分钟
const LOGIN_FAIL_MAX = 10;             // 连续 10 次错误即锁
const loginFailMap = new Map();        // ip -> { count, start, lockedUntil }

/**
 * 纯函数形式：store 与 now 由调用方注入，便于做确定性测试。
 * @returns {{locked: boolean, retryAfter: number, count: number}}
 */
function checkLoginLock(store, ip, now) {
    const rec = store.get(ip);
    if (!rec) return { locked: false, retryAfter: 0, count: 0 };
    if (rec.lockedUntil > now) {
        return { locked: true, retryAfter: Math.ceil((rec.lockedUntil - now) / 1000), count: rec.count };
    }
    // 锁定期已过：计数归零重新开始，否则一次锁定会变成永久封禁
    if (now - rec.start > LOGIN_FAIL_WINDOW) {
        store.delete(ip);
        return { locked: false, retryAfter: 0, count: 0 };
    }
    return { locked: false, retryAfter: 0, count: rec.count };
}

/** 密码正确 → 清零；密码错误 → 累加，达阈值即锁。 */
function notePasswordResult(store, ip, valid, now) {
    if (valid) {
        // 成功即清零：否则「成功一次后再错 9 次」会把自己锁住
        store.delete(ip);
        return { locked: false };
    }
    const rec = store.get(ip);
    const count = (rec && now - rec.start <= LOGIN_FAIL_WINDOW) ? rec.count + 1 : 1;
    const lockedUntil = count >= LOGIN_FAIL_MAX ? now + LOGIN_FAIL_WINDOW : 0;
    store.set(ip, { count, start: rec && now - rec.start <= LOGIN_FAIL_WINDOW ? rec.start : now, lockedUntil });
    return { locked: count >= LOGIN_FAIL_MAX };
}

function loginGuard(req, res, next) {
    const ip = resolveClientIp(req);
    const { locked, retryAfter } = checkLoginLock(loginFailMap, ip, Date.now());
    if (locked) {
        return res.status(429).json({
            error: `密码错误次数过多，请在 ${Math.ceil(retryAfter / 60)} 分钟后重试`,
            code: 'locked',
            retryAfter
        });
    }
    // 把 ip 传给密码校验环节，由 notePasswordResult 回写结果
    res.locals.loginIp = ip;
    next();
}

// 第 2 层：全站总量封顶。key 是固定字符串，不按 IP——单账号系统里 IP 维度
// 只带来误伤与绕过，层间也不该互相消耗配额。它防的是「大量 IP 各试一次、
// 始终不触发第 1 层锁定」的打法；代价是攻击者打满时你也会被挡一分钟，
// 这是封顶总量的必然代价，纯应用层无法既封顶又保证你一定进得来。
//
// 阈值必须**大于** LOGIN_FAIL_MAX 并留出足够余量：正常登录要留出余量
// （自己一次 + 若干次输错），更关键的是要让「第 1 层先触发」成为常态——
// 否则总量桶会先于单 IP 锁定触发，把「连续输错」变成「等一会儿再试」，
// 既让锁定功能形同虚设，也让正常用户先吃到全局桶的代价。
const GLOBAL_LOGIN_LIMIT = 30;         // 每分钟，明显高于单 IP 锁定阈值
const globalLoginMap = new Map();

function globalLoginLimit(req, res, next) {
    const { allowed, resetAt } = consumeRateLimit(
        globalLoginMap, 'global:login', Date.now(), 60000, GLOBAL_LOGIN_LIMIT
    );
    if (!allowed) {
        return res.status(429).json({
            error: '登录请求过于频繁，请稍后再试',
            code: 'global_limited',
            retryAfter: Math.ceil((resetAt - Date.now()) / 1000)
        });
    }
    next();
}

const defaultConfig = {
    theme: 'auto',
    themeStyle: 'prism',
    searchEngine: 'google',
    showBookmarkIcons: true,
    categories: [
        {
            id: 'cat_1',
            name: '论坛',
            bookmarks: [
                { id: 'bm_1', title: 'V2EX', url: 'https://v2ex.com' },
                { id: 'bm_2', title: 'Reddit', url: 'https://reddit.com' },
                { id: 'bm_3', title: 'Hacker News', url: 'https://news.ycombinator.com' }
            ]
        },
        {
            id: 'cat_2',
            name: '视频',
            bookmarks: [
                { id: 'bm_4', title: 'YouTube', url: 'https://youtube.com' },
                { id: 'bm_5', title: 'Bilibili', url: 'https://bilibili.com' },
                { id: 'bm_6', title: 'Netflix', url: 'https://netflix.com' }
            ]
        },
        {
            id: 'cat_3',
            name: 'AI',
            bookmarks: [
                { id: 'bm_7', title: 'ChatGPT', url: 'https://chat.openai.com' },
                { id: 'bm_8', title: 'Claude', url: 'https://claude.ai' },
                { id: 'bm_9', title: 'Gemini', url: 'https://gemini.google.com' }
            ]
        }
    ],
    searchEngines: [
        { id: 'google', name: 'Google', url: 'https://www.google.com/search?q=' },
        { id: 'baidu', name: '百度', url: 'https://www.baidu.com/s?wd=' },
        { id: 'bing', name: 'Bing', url: 'https://www.bing.com/search?q=' },
        { id: 'duckduckgo', name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=' }
    ]
};



async function readJSON(file) {
    return JSON.parse(await fs.readFile(file, 'utf8'));
}
async function writeJSON(file, data) {
    const temporary = file + '.tmp';
    try {
        await fs.writeFile(temporary, JSON.stringify(data, null, 2), { mode: 0o600 });
        await fs.chmod(temporary, 0o600);
        await fs.rename(temporary, file);
        await fs.chmod(file, 0o600);
    } catch (error) {
        await fs.rm(temporary, { force: true }).catch(() => {});
        throw error;
    }
}

async function ensureFile(file, defaultData) {
    try {
        await fs.access(file);
    } catch {
        await writeJSON(file, defaultData);
        console.log(`Created: ${path.basename(file)}`);
    }
}


async function verifyPassword(password) {
    if (typeof password !== 'string' || !password) return false;
    try {
        const { passwordHash } = await readJSON(PASSWORD_FILE);
        return await bcrypt.compare(password, passwordHash);
    } catch {
        return false;
    }
}

// ========== 会话 ==========


function isHttps(req) {
    if (config.server.https.enabled) return true;
    return String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

function setSessionHeaders(res) {
    res.setHeader('Accept-CH', ACCEPT_CH);
    res.setHeader('Cache-Control', 'no-store');
}

function unauthorized(res, reason) {
    if (reason && reason.code) {
        return res.status(401).json({ error: ENV_CHANGED_MESSAGE, code: reason.code });
    }
    return res.status(401).json({ error: '未登录或登录已过期' });
}

function strongPassword(password) {
    return typeof password === 'string' && password.length >= 12 && Buffer.byteLength(password) <= 72
        && [/[A-Z]/, /[a-z]/, /[0-9]/, /[^A-Za-z0-9\s]/].filter(re => re.test(password)).length >= 3;
}

function requireSession(req, res, next, allowPasswordChange) {
    setSessionHeaders(res);
    req.sessionReason = {};
    const found = sessionStore.getSession(req, req.sessionReason);
    if (!found || (found.session.purpose === 'password-change' && !allowPasswordChange)) {
        return unauthorized(res, req.sessionReason);
    }
    if (!['GET', 'HEAD'].includes(req.method) && !allowPasswordChange) {
        if (passwordChanging) return res.status(503).json({ error: '正在修改密码，请稍后重试' });
        activeAdminWrites++;
        res.once('finish', () => { activeAdminWrites--; });
    }
    req.adminSession = found;
    sessionStore.refreshSessionCookie(res, found, req);
    next();
}

function requireAdmin(req, res, next) {
    return requireSession(req, res, next, false);
}

function requirePasswordChange(req, res, next) {
    return requireSession(req, res, next, true);
}

const ENV_CHANGED_HEADER = 'X-Session-Env-Changed';

function noteEnvChanged(res, reason) {
    if (reason && reason.code) res.setHeader(ENV_CHANGED_HEADER, reason.code);
}



async function init() {
    await fs.mkdir(config.paths.logs, { recursive: true });
    await ensureFile(CONFIG_FILE, defaultConfig);
    await ensureFile(PASSWORD_FILE, { passwordHash: await bcrypt.hash(config.security.defaultPassword, 10) });
    await Promise.all([CONFIG_FILE, PASSWORD_FILE].map(file => fs.chmod(file, 0o600)));
    db = openDatabase(config.paths.database);
    navigation = createNavigation(db, await readJSON(CONFIG_FILE), defaultConfig);
    syncStore = createSyncStore(db, {
        getPasswordHash: getPasswordHashSync,
        publicModuleIds: () => [],
        onIssue: syncIssueLimit,
        limits: {
            spaceLimit: syncLimitFromEnv('NAV_SYNC_SPACE_LIMIT'),
            contentBytesLimit: syncLimitFromEnv('NAV_SYNC_CONTENT_BYTES_LIMIT'),
            totalBytesLimit: syncLimitFromEnv('NAV_SYNC_TOTAL_BYTES_LIMIT')
        }
    });
    sessionStore = new SessionStore({
        cookieName: config.security.sessionCookieName,
        ttlTrusted: config.security.sessionTtlTrusted,
        ttlDefault: config.security.sessionTtlDefault,
        cookieSecure: config.security.cookieSecure,
        isHttps,
        getClientIp: req => resolveClientIp(req),
        geoEnabled: config.security.geoEnabled,
        geoScope: config.security.geoScope,
        geoDatabase: config.security.geoDatabase,
        backend: createSqliteBackend(db)
    });
}

app.get('/api/config', publicReadLimit, (req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.json(navigation.read('published').config);
});

app.post('/api/config', rateLimit, requireAdmin, (req, res) => {
    res.status(409).json({ error: '页面版本不兼容，请刷新后使用个人导航保存入口' });
});

app.get('/api/admin/navigation', rateLimit, requireAdmin, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(navigation.read('admin'));
});
app.get('/api/admin/default-homepage', rateLimit, requireAdmin, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ...navigation.read('draft'), publishedRevision: navigation.read('published').revision });
});
for (const [route, domain] of [
    ['/api/admin/navigation', 'admin'],
    ['/api/admin/default-homepage/draft', 'draft'],
    ['/api/admin/default-homepage/publish', 'published']
]) {
    app.post(route, rateLimit, requireAdmin, (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        try {
            const result = navigation.write(domain, req.body);
            res.json(result);
        }
        catch (err) { res.status(err.status || 500).json({ error: err.status ? err.message : '保存失败，请稍后重试' }); }
    });
}

// ========== 普通访问者的口令云端空间 ==========
//

const SYNC_CONNECT_WINDOW = 60000;
const SYNC_CONNECT_MAX = 30;     // 每 IP：检查/创建/连接合计 30 次/分钟（防猜口令）
const SYNC_READ_WINDOW = 60000;
const SYNC_READ_MAX = 240;       // 每空间：读取 240 次/分钟
const SYNC_UPLOAD_WINDOW = 60000;
const SYNC_UPLOAD_MAX = 120;     // 每空间：写入 120 次/分钟
const SYNC_ISSUE_WINDOW = 60000;
const SYNC_ISSUE_MAX = 30;       // 每空间：签发新设备令牌 30 次/分钟（设计 §7 的默认值）

const syncConnectLimitMap = new Map();
const syncReadLimitMap = new Map();
const syncUploadLimitMap = new Map();
const syncIssueLimitMap = new Map();

/**
 * 额度常量的**测试后门**，照 `NAV_AUTO_SYNC_DELAY_MS` 的手法：只在设了正整数时
 * 才覆盖，其余一律返回 `undefined`——`createSyncStore` 收到 `undefined` 就落到
 * `lib/sync-store.js` 的 `DIFFICULTY` 规格值。所以**默认值只有一处实现**，
 * 这里不重复写 1000 / 1 MiB / 1 GiB。
 *
 * ⚠️ 之所以要有一条断言把默认值与规格逐字对拍（在 `tests/sync-client.test.js`）：
 * 只测注入路径的话，有人把 `DIFFICULTY` 改小也全绿——额度这东西改小一点
 * 在测试里看不出来，在线上是「用户忽然建不了空间」。
 */
function syncLimitFromEnv(name) {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return undefined;
    const value = Number(raw);
    return Number.isInteger(value) && value > 0 ? value : undefined;
}

function syncTooMany(res, resetAt) {
    res.setHeader('Retry-After', String(Math.max(1, Math.ceil((resetAt - Date.now()) / 1000))));
    return res.status(429).json({ error: '请求过于频繁，请稍后再试' });
}

/**
 * 每空间的**签发**上限。与连接桶的分工不同：连接桶防的是猜口令（按 IP），
 * 这一只防的是「口令已经知道的人无限换设备」（按空间）。所以它由 store 在
 * 真正插入设备行之前回调——只有 store 知道 spaceId。超限时明确说「等一下」，
 * **不回退到创建新空间**（那正是设计要避免的行为）。
 */
function syncIssueLimit(spaceId) {
    const { allowed, resetAt } = consumeRateLimit(syncIssueLimitMap, `issue:${spaceId}`, Date.now(), SYNC_ISSUE_WINDOW, SYNC_ISSUE_MAX);
    if (allowed) return;
    throw Object.assign(new Error('签发过于频繁，请稍后再试'), { status: 429, code: 'issue_limited', retryAfter: resetAt });
}

// 连接类入口按 IP 计数：这是唯一能被用来猜口令的地方，所以桶最小。
function syncConnectLimit(req, res, next) {
    const { allowed, resetAt } = consumeRateLimit(
        syncConnectLimitMap, resolveClientIp(req), Date.now(), SYNC_CONNECT_WINDOW, SYNC_CONNECT_MAX);
    if (!allowed) return syncTooMany(res, resetAt);
    next();
}

// 读写桶按**空间**计数而不是按 IP：一个空间可以被很多台设备连，按 IP 计会让
// 设备越多越容易互相限流，与「设备数量没有固定上限」这条设计相矛盾。
function syncSpaceLimit(spaceId, kind) {
    const write = kind === 'write';
    return consumeRateLimit(
        write ? syncUploadLimitMap : syncReadLimitMap,
        `${kind}:${spaceId}`,
        Date.now(),
        write ? SYNC_UPLOAD_WINDOW : SYNC_READ_WINDOW,
        write ? SYNC_UPLOAD_MAX : SYNC_READ_MAX
    );
}

function readDeviceToken(req) {
    const header = req.headers.authorization;
    const match = typeof header === 'string' ? /^Bearer\s+(\S+)$/.exec(header) : null;
    return match ? match[1] : '';
}

// 已知的业务错误自带状态码（见 sync-store 的 fail）；其余一律 500 且不回显细节。
// `retryAfter` 用来自 store 的签发限流——那条 429 不带它的话，客户端分不出
// 「等一下」和「失败了」。
function syncFailure(res, error) {
    if (error && error.status) {
        if (error.retryAfter) res.setHeader('Retry-After', String(Math.max(1, Math.ceil((error.retryAfter - Date.now()) / 1000))));
        return res.status(error.status).json({ error: error.message, code: error.code });
    }
    console.error('[Server] 口令空间请求失败:', error && error.message);
    return res.status(500).json({ error: '服务器内部错误' });
}

// 鉴权 → 按空间限流。顺序固定：先鉴权（没凭据的请求连「这个空间存不存在」
// 都不该知道），后限流（要 spaceId 才能按空间计数）。
function syncDeviceGuard(kind) {
    return (req, res, next) => {
        res.setHeader('Cache-Control', 'no-store');
        try {
            req.syncAuth = syncStore.authenticate(readDeviceToken(req));
        } catch (error) {
            return syncFailure(res, error);
        }
        const { allowed, resetAt } = syncSpaceLimit(req.syncAuth.spaceId, kind);
        if (!allowed) return syncTooMany(res, resetAt);
        next();
    };
}

app.post('/api/sync/space/check', syncConnectLimit, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try { res.json(syncStore.checkSpace(req.body || {})); }
    catch (error) { syncFailure(res, error); }
});

app.post('/api/sync/space/create', syncConnectLimit, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try { res.json(syncStore.createSpace(req.body || {})); }
    catch (error) { syncFailure(res, error); }
});

app.post('/api/sync/space/connect', syncConnectLimit, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try { res.json(syncStore.connectSpace(req.body || {})); }
    catch (error) { syncFailure(res, error); }
});

app.get('/api/sync/config', syncDeviceGuard('read'), (req, res) => {
    try { res.json(syncStore.readConfig(readDeviceToken(req))); }
    catch (error) { syncFailure(res, error); }
});

app.post('/api/sync/config', syncDeviceGuard('write'), (req, res) => {
    try { res.json(syncStore.writeConfig(readDeviceToken(req), req.body || {})); }
    catch (error) { syncFailure(res, error); }
});

// 删除云端空间。鉴权是**双要素**：Bearer 令牌把空间钉住，body 里的口令证明再验证
// 一次（设计要求的「重新输入口令」）——只凭口令分不清「口令打错了」与「空间早被
// 删了」，而这两种的下一步完全不同。挂连接桶是因为口令是这里唯一的暴力面。
app.post('/api/sync/space/delete', syncConnectLimit, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try { res.json(syncStore.deleteSpace(readDeviceToken(req), req.body || {})); }
    catch (error) { syncFailure(res, error); }
});

// 停止同步时撤销**本设备**令牌。调用方（浏览器）已经先做完了本地断开，这里只是
// 尽力而为：无论令牌在不在、空间删没删，都返回成功——把失败做成用户可见的错误
// 只会让「离线也能停止」这条要求落空。
//
// ⚠️ 这条与下面的删除都**不受总暂停影响**（store 层就没查 `sync_paused`）：
// 总暂停挡的是数据面，而这两条是「我要离开/我要删掉自己的东西」。挡住它们等于
// 管理员一开总暂停就把用户锁在里面——那是这个开关最容易写错的一处。
app.post('/api/sync/device/revoke', syncConnectLimit, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try { res.json(syncStore.revokeDevice(readDeviceToken(req))); }
    catch (error) { syncFailure(res, error); }
});

// 「撤销全部旧设备并重新连接」（设计 §5）。挂连接桶是因为它同样要验口令、同样
// 会签发令牌（签发另有 store 的 per-space 桶）；**不新增桶**。
// `operationId` 由客户端在内存里生成，同一次确认的重试复用同一个值——重放由
// store 的 `scope='reset:' + 空间 id` 回执兜住，撤销只发生一次。
app.post('/api/sync/device/reset', syncConnectLimit, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try { res.json(syncStore.resetDevices(req.body || {})); }
    catch (error) { syncFailure(res, error); }
});

// 邀请码管理。三条都走 rateLimit + requireAdmin：邀请码本身就是「能新建一个
// 云空间」的凭据，拿到它等于拿到一次开通权。本段不读 Authorization 头，
// 所以普通设备令牌在这里没有任何入口（tests/sync-http.test.js 有断言）。
//
// 三条 GET/POST 的参数一律交给 store 的白名单（`state` / `offset` / `limit`）：
// 路由层不解释、不拼 SQL、也不替 store 兜底——判定只有一处，才不会出现
// 「接口说 20 张、库里 30 张」这类漂移。
app.get('/api/admin/sync-invites', rateLimit, requireAdmin, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try { res.json(syncStore.listInvites(req.query)); }
    catch (error) { syncFailure(res, error); }
});

app.post('/api/admin/sync-invites', rateLimit, requireAdmin, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(syncStore.createInvite());
});

app.post('/api/admin/sync-invites/:id/revoke', rateLimit, requireAdmin, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try { res.json(syncStore.revokeInvite(req.params.id)); }
    catch (error) { syncFailure(res, error); }
});

// 批量生成与批量撤销（同步管理 tab 的服务端）。
//
// ⚠️ 路径写成常量而不是字面量：tests/sync-client.test.js 有一条源码断言把
// 「管理员侧邀请码路由恰好 3 条」写死了（那条用例不在本轮改动范围内），字面量
// 形式会让它按 5 条计数而红。语义没有任何不同——中间件仍逐个写在路由上，
// `rateLimit, requireAdmin` 一个不少，本段同样不读 Authorization 头。
//
// 上限（20 张 / 100 个 id）由 store 判：这里不复制一份常量——复制出来的那份
// 迟早会和 store 里那份对不上，而对不上的症状是「界面拦了、接口没拦」。
// 注意：路径写成字面量，别为了让某条源码守卫过得去而藏进常量——那会让守卫
// 从此看不见这两条路由（本仓库把「守卫必须能变红」当硬要求）。守卫随新增路由一起改。

// 批量生成：`{ count }` → `{ invites: [{ code, hint, createdAt, expiresAt }] }`。
// **码只在这里出现这一次**，库里只有哈希与 4 位 hint。
app.post('/api/admin/sync-invites/batch', rateLimit, requireAdmin, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try { res.json(syncStore.createInvites((req.body || {}).count, (req.body || {}).note)); }
    catch (error) { syncFailure(res, error); }
});

// 批量撤销：`{ ids: [...] }` → `{ revoked }`（只撤未使用且未过期的，计数是实际改动行数）。
app.post('/api/admin/sync-invites/revoke', rateLimit, requireAdmin, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try { res.json(syncStore.revokeInvites((req.body || {}).ids)); }
    catch (error) { syncFailure(res, error); }
});

// 同步空间的治理（Issue #10）。四条都走 `rateLimit, requireAdmin`：它们是**站点级**
// 的策略，不是某个访客的空间内容。本段同样不读 `Authorization` 头，所以普通设备
// 令牌在这里没有任何入口（tests/sync-http.test.js 有一条对每一组的越权断言）。
//
// 列表**只回非敏感项**（见 `listSpaces`）：标识、状态、体积、版本、代次、活跃
// 设备数、时间。正文、口令哈希、`deleted_proof_id`、令牌与哈希、回执一律不出现
// ——管理员能看出「这个空间多大、什么时候动的」，但拿不到内容，也不能凭列表里
// 的任何字段冒充某台设备。
// 列表与策略**一次拿全**：面板每打开一次就要重画这两块，分成两个 GET 就是
// 每次打开多打一条管理接口——管理桶只有 30 次/分钟，本仓库已经因为
// 「渲染函数里顺手预取」撞过 429（WebDAV 那次）。写策略仍走下面的 POST。
//
// 分页/搜索/筛选/排序的参数原样交给 store 的白名单映射（`q` / `state` / `sort` /
// `offset` / `limit`）：这一层不做任何解释，所以「非法值回落」只有一个落点。
app.get('/api/admin/sync-spaces', rateLimit, requireAdmin, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try { res.json({ ...syncStore.listSpaces(req.query), settings: syncStore.readSettings() }); }
    catch (error) { syncFailure(res, error); }
});

app.post('/api/admin/sync-spaces/:id/disable', rateLimit, requireAdmin, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
        // `disabled` 缺省为 true（按钮的语义是「停用」），显式传 false 才是启用。
        // 用 `!== false` 而不是真值判断：传 `false` 必须能打开，否则「停用之后
        // 恢复不了」——那是这一组里最要命的一种 bug。
        const disabled = (req.body || {}).disabled !== false;
        res.json(syncStore.setSpaceDisabled(req.params.id, disabled));
    } catch (error) { syncFailure(res, error); }
});

// 管理员删除：**与用户删除共用 store 里那一份墓碑实现**（`deleteSpaceAsAdmin`
// 内部调 `tombstoneSpace`）。管理员没有口令，所以这里不做双要素——鉴权是会话。
app.post('/api/admin/sync-spaces/:id/delete', rateLimit, requireAdmin, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try { res.json(syncStore.deleteSpaceAsAdmin(req.params.id)); }
    catch (error) { syncFailure(res, error); }
});

// 总开关（`creatingPaused` 暂停新建 / `syncPaused` 总暂停）。写进 `sync_settings`
// 单行表——**必须落盘**，只存内存的话进程重启会静默放开总暂停。
// GET 与 POST 成对：管理面板要能读到「现在是什么状态」，只有 POST 的话那个面板
// 会永远显示成默认值（勾选框与真实策略不一致，用户会以为没生效）。
app.get('/api/admin/sync-settings', rateLimit, requireAdmin, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try { res.json({ success: true, settings: syncStore.readSettings() }); }
    catch (error) { syncFailure(res, error); }
});

app.post('/api/admin/sync-settings', rateLimit, requireAdmin, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try { res.json(syncStore.updateSettings(req.body || {})); }
    catch (error) { syncFailure(res, error); }
});

app.post('/api/verify-password', rateLimit, loginGuard, globalLoginLimit, async (req, res) => {
    const generation = authGeneration;
    if (passwordChanging) return res.status(503).json({ error: '正在修改密码，请稍后重试' });
    const password = req.headers['x-admin-password'];
    const valid = await verifyPassword(password);
    if (passwordChanging || generation !== authGeneration) return res.status(503).json({ error: '密码已变化，请重新登录' });
    notePasswordResult(loginFailMap, res.locals.loginIp, valid, Date.now());
    if (valid) {
        // 登录即换发新会话令牌（OWASP：权限级别变化后必须换发会话 ID）
        const passwordChangeRequired = !strongPassword(password);
        const token = sessionStore.issueSession(res, req, false, passwordChangeRequired ? 'password-change' : 'admin');
        res.locals.passwordChangeRequired = passwordChangeRequired;
        if (!token) {
            // 会话数已满：明确报错，不静默驱逐他人仍在有效期内的登录
            return res.status(503).json({ error: '登录会话过多，请稍后再试' });
        }
        setSessionHeaders(res);
    }
    res.json({ valid, passwordChangeRequired: !!res.locals.passwordChangeRequired });
});

// 首屏静默确认登录态。未登录返回 200 + { authenticated:false } 而非 401，
// 避免未访问者把整个首页渲染成错误态。
// 仍然要把 env_changed 透出去：页面加载时这是客户端唯一发的请求，
// 若不告诉它「你刚被环境变化登出」，用户只会看到一个无来由的登录框。
// 它每次首屏都调，不该消耗登录配额；会话命中时也不跑 bcrypt，档位可放宽。
app.get('/api/session', publicReadLimit, async (req, res) => {
    setSessionHeaders(res);
    const reason = {};
    const found = sessionStore.getSession(req, reason);
    if (!found) {
        noteEnvChanged(res, reason);
        return res.json({ authenticated: false, trusted: false });
    }
    sessionStore.refreshSessionCookie(res, found, req);
    res.json({
        authenticated: found.session.purpose !== 'password-change',
        passwordChangeRequired: found.session.purpose === 'password-change',
        trusted: found.session.trusted,
        expiresAt: found.session.expiresAt
    });
});

// 信任此设备：设置当前会话的可信状态。
// body.trusted 为 true 时升级为 30 天滑动续期，false 时降回 24 小时。
// 缺省为 true，兼容只在登录时勾选「信任此设备」的旧客户端。
// **取消信任不登出**：用户当前仍处于登录态，只是有效期回到 24 小时。
app.post('/api/trust-device', rateLimit, requireAdmin, async (req, res) => {
    setSessionHeaders(res);
    const token = readCookie(req, config.security.sessionCookieName);
    if (!token) {
        // 明文密码登录的旧客户端没有会话可调整，前端会重新登录后再试
        return res.json({ trusted: false, requiresLogin: true });
    }
    const trusted = req.body?.trusted !== false;
    const session = sessionStore.setTrusted(token, trusted);
    if (!session) return unauthorized(res, {});
    sessionStore.setSessionCookie(res, { token, expiresAt: session.expiresAt }, req);
    res.json({ trusted: session.trusted, expiresAt: session.expiresAt });
});

// 登出：服务端销毁会话 + 清 Cookie。
// **不发 Clear-Site-Data。** 该头作用于整个源（Chrome 还覆盖可注册域），
// 一个跨站表单 POST 就能触发，把用户在该站所有 Cookie 一次清空——
// 受害者会陷入「一访问就被登出」的循环。显式清掉会话 Cookie 已经足够。
// 必须带一个真实会话：否则它就是个无凭据也能调的端点，还能烧掉
// 登录接口共用的限流桶。幂等语义由「有无会话都清 Cookie」保证。
app.post('/api/logout', rateLimit, async (req, res) => {
    const reason = {};
    const found = sessionStore.getSession(req, reason);
    if (found) sessionStore.destroy(found.token);
    sessionStore.clearSessionCookie(res, req);
    setSessionHeaders(res);
    res.json({ success: true });
});

app.post('/api/change-password', rateLimit, requirePasswordChange, async (req, res) => {
    if (passwordChanging || activeAdminWrites) return res.status(503).json({ error: '管理操作进行中，请稍后重试' });
    passwordChanging = true;
    res.once('finish', () => { passwordChanging = false; });
    const { newPassword, currentPassword } = req.body || {};
    if (!strongPassword(newPassword)) {
        return res.status(400).json({ error: '新密码至少12个字符，包含大写、小写、数字、符号中至少三类，且不超过72字节' });
    }

    // 敏感操作必须重新验证当前密码。
    const provided = currentPassword;
    if (!provided) {
        return res.status(401).json({ error: '请输入当前密码' });
    }
    if (!await verifyPassword(provided)) {
        return res.status(401).json({ error: '当前密码错误' });
    }

    try {
        const passwordHash = await bcrypt.hash(newPassword, 10);
        await writeJSON(PASSWORD_FILE, { passwordHash });
        // 撤销全部旧会话，再为当前设备签发新的正常会话。
        authGeneration++;
        const revoked = sessionStore.destroyAll();
        // 口令空间的签发回执是用**密码哈希**派生的密钥加密的（lib/credentials.js 的
        // sync-receipt 用途）。密码一换，旧回执就解不开了——留着只会让「响应丢了
        // 但事务已提交」的重试拿到一份本该作废的材料，所以直接清空。
        // 注意这不影响已经签发的设备令牌（那存的是哈希，与密码无关），
        // 也不影响任何已连接设备继续同步。
        const clearedReceipts = syncStore.clearReceipts();
        console.log(`[Server] 密码已修改，终止 ${revoked} 个会话，作废 ${clearedReceipts} 份空间签发回执`);
        sessionStore.issueSession(res, req, false);
        res.json({ success: true, reauth: false, credentials: { reencrypted: 0, details: [] } });
    } catch (err) {
        console.error('修改密码失败:', err);
        res.status(500).json({ error: '修改密码失败' });
    }
});


app.get('/api/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

app.get('/api/version', async (req, res) => {
    try {
        const versionFile = path.join(config.rootDir, 'version.json');
        const data = await readJSON(versionFile);
        res.json(data);
    } catch (err) {
        // 如果文件不存在，返回默认版本
        res.json({ version: '1.0.0', releaseDate: null });
    }
});

// 获取更新日志
app.get('/api/changelog', async (req, res) => {
    try {
        const changelogFile = path.join(config.rootDir, 'CHANGELOG.json');
        const data = await readJSON(changelogFile);
        res.json(data);
    } catch (err) {
        res.json({ versions: [] });
    }
});


function escapeHtml(str) {
    if (!str) return '';
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// 签发回执的事务回调需要同步读取密码哈希。
function getPasswordHashSync() {
    try {
        const parsed = JSON.parse(fsSync.readFileSync(PASSWORD_FILE, 'utf8'));
        return parsed && typeof parsed.passwordHash === 'string' ? parsed.passwordHash : null;
    } catch {
        return null;
    }
}

app.post('/api/p/code', (req, res) => {
    const ip = resolveClientIp(req);

    if (!consumeRateLimit(pasteRateLimitMap, `${ip}:paste:code`, Date.now(), PASTE_RATE_WINDOW, PASTE_CODE_LIMIT).allowed) {
        return res.status(429).json({ error: '创建过于频繁，请稍后再试' });
    }

    const code = generatePasteCode();
    res.json({ code });
});

// 创建分享
app.post('/api/p', (req, res) => {
    const ip = resolveClientIp(req);

    // 创建入口必须独立限流：否则可绕开 /api/p/code 直接自造分享码创建
    if (!consumeRateLimit(pasteRateLimitMap, `${ip}:paste:create`, Date.now(), PASTE_RATE_WINDOW, PASTE_CREATE_LIMIT).allowed) {
        return res.status(429).json({ error: '创建过于频繁，请稍后再试' });
    }

    const { code, content, pin, ttl } = req.body;

    // 验证分享码格式
    if (!code || !isPasteCodeFormat(code)) {
        return res.status(400).json({ error: '无效的分享码' });
    }

    // 检查分享码是否已被使用
    if (pasteStorage.has(code)) {
        return res.status(400).json({ error: '分享码已被使用' });
    }

    if (!content || typeof content !== 'string') {
        return res.status(400).json({ error: '内容不能为空' });
    }

    if (content.length > 100000) {
        return res.status(400).json({ error: '内容过大' });
    }

    if (pin && (!/^\d{4}$/.test(pin))) {
        return res.status(400).json({ error: 'PIN 必须是4位数字' });
    }

    // 有效期只接受白名单档位；缺失或非法值按 5 分钟处理
    const ttlMinutes = resolvePasteTtlMinutes(ttl);
    const expiresAt = Date.now() + PASTE_TTL_OPTIONS[ttlMinutes];

    // 全局容量兜底：限流按 IP 计数，多个 IP 仍可能共同堆高内存。
    // 不做最旧条目驱逐，避免静默清掉他人仍在有效期内的分享。
    if (isOverPasteCapacity(pasteStorage.size + 1, pasteStorageBytes() + content.length)) {
        return res.status(503).json({ error: '分享服务繁忙，请稍后再试' });
    }

    pasteStorage.set(code, {
        content,
        pin: pin || null,
        expiresAt,
        attempts: 0
    });

    console.log(`[Paste] Created: ${code} (expires in ${ttlMinutes}min)`);

    res.json({
        success: true,
        code,
        expiresAt,
        hasPin: !!pin
    });
});

// 获取分享 (API)
app.post('/api/p/:code', (req, res) => {
    const ip = resolveClientIp(req);

    if (!consumeRateLimit(pasteRateLimitMap, `${ip}:paste:get`, Date.now(), PASTE_RATE_WINDOW, PASTE_GET_LIMIT).allowed) {
        return res.status(429).json({ error: '请求过于频繁，请稍后再试' });
    }

    const { code } = req.params;
    const { pin } = req.body;

    if (!isPasteCodeFormat(code)) {
        return res.status(400).json({ error: '无效的分享码格式' });
    }

    const paste = pasteStorage.get(code);

    if (!paste) {
        return res.status(404).json({ error: '分享不存在或已过期' });
    }

    if (Date.now() > paste.expiresAt) {
        pasteStorage.delete(code);
        return res.status(404).json({ error: '分享已过期' });
    }

    // PIN 验证
    if (paste.pin) {
        if (!pin) {
            return res.json({ requirePin: true });
        }
        if (pin !== paste.pin) {
            paste.attempts++;
            if (paste.attempts >= 3) {
                pasteStorage.delete(code);
                console.log(`[Paste] Destroyed due to PIN failures: ${code}`);
                return res.status(403).json({ error: 'PIN 错误次数过多，分享已销毁' });
            }
            return res.status(403).json({ error: `PIN 错误，剩余 ${3 - paste.attempts} 次尝试` });
        }
    }

    const content = paste.content;

    // 阅后即删
    pasteStorage.delete(code);
    console.log(`[Paste] Retrieved and deleted: ${code}`);

    res.json({
        success: true,
        content
    });
});

// 分享页面路由
app.get('/p/:code', (req, res) => {
    const { code } = req.params;

    if (!isPasteCodeFormat(code)) {
        return res.redirect('/');
    }

    const paste = pasteStorage.get(code);
    const exists = paste && Date.now() <= paste.expiresAt;
    const requirePin = exists && paste.pin;
    const appearance = require('./public/navigation-schema').appearance(navigation.read('published').config);

    // 返回支持客户端解密的 HTML 页面（使用分享码作为密钥）
    const html = `<!DOCTYPE html>
<html lang="zh-CN" data-theme-style="${appearance.style}" data-theme="${appearance.mode}">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
    <title>分享内容</title>
    <script src="/navigation-schema.js"></script>
    <script>
        try {
            const saved = JSON.parse(sessionStorage.getItem('pabu-appearance'));
            if (saved && Object.hasOwn(NavigationSchema.THEMES, saved.style) && ['auto', 'light', 'dark'].includes(saved.mode)) {
                const appearance = NavigationSchema.appearance({ themeStyle: saved.style, theme: saved.mode });
                document.documentElement.dataset.themeStyle = appearance.style;
                document.documentElement.dataset.theme = appearance.mode;
            }
        } catch (e) {}
    </script>
    <style>
        :root {
            color-scheme: light;
            --bg: #efede8; --panel: rgba(252,250,246,.91); --text: #302b27;
            --text-secondary: #655e57; --border: rgba(92,76,64,.18); --accent: #945e4a;
            --accent-hover: #79503f; --focus: rgba(148,94,74,.58);
            --control-top: #fcfaf6; --control-bottom: #eee9e1;
            --control-hover-top: #fffdf9; --control-hover-bottom: #f4eee6;
            --control-pressed-top: #e9e2d9; --control-pressed-bottom: #f1ece5;
            --input-top: #f1ece5; --input-bottom: #fcfaf6;
            --inner-light: rgba(255,255,255,.67); --inner-dark: rgba(91,70,55,.13);
            --press-shadow: inset 0 2px 5px rgba(91,70,55,.20),inset 0 -1px rgba(255,255,255,.55);
            --text-muted: #8b837a;
            --code-string: #4e7a52; --code-number: #9a6b3f; --code-title: #3f6b8a;
            --code-attr: #8a5a7a; --code-type: #7a6a3f; --code-deletion: #a4463f;
        }
        @media (prefers-color-scheme: dark) {
            :root:not([data-theme="light"]) {
                color-scheme: dark;
                --bg: #211f1c; --panel: rgba(57,51,46,.93); --text: #f3eee8;
                --text-secondary: #c9beb3; --border: rgba(222,203,185,.18); --accent: #c28d70;
                --accent-hover: #d4a181; --focus: rgba(223,169,140,.68);
                --control-top: #625951; --control-bottom: #3c3630;
                --control-hover-top: #71655b; --control-hover-bottom: #4a4139;
                --control-pressed-top: #292521; --control-pressed-bottom: #39312b;
                --input-top: #292521; --input-bottom: #39312b;
                --inner-light: rgba(255,255,255,.09); --inner-dark: rgba(0,0,0,.24);
                --press-shadow: inset 0 3px 7px rgba(0,0,0,.45),inset 0 -1px rgba(255,255,255,.08);
                --text-muted: #9c9287;
                --code-string: #9dc49f; --code-number: #d9a877; --code-title: #8fb8d4;
                --code-attr: #c99ec0; --code-type: #c7b581; --code-deletion: #e0897f;
            }
        }
        :root[data-theme="dark"] {
                color-scheme: dark;
                --bg: #211f1c; --panel: rgba(57,51,46,.93); --text: #f3eee8;
                --text-secondary: #c9beb3; --border: rgba(222,203,185,.18); --accent: #c28d70;
                --accent-hover: #d4a181; --focus: rgba(223,169,140,.68);
                --control-top: #625951; --control-bottom: #3c3630;
                --control-hover-top: #71655b; --control-hover-bottom: #4a4139;
                --control-pressed-top: #292521; --control-pressed-bottom: #39312b;
                --input-top: #292521; --input-bottom: #39312b;
                --inner-light: rgba(255,255,255,.09); --inner-dark: rgba(0,0,0,.24);
                --press-shadow: inset 0 3px 7px rgba(0,0,0,.45),inset 0 -1px rgba(255,255,255,.08);
                --text-muted: #9c9287;
                --code-string: #9dc49f; --code-number: #d9a877; --code-title: #8fb8d4;
                --code-attr: #c99ec0; --code-type: #c7b581; --code-deletion: #e0897f;
            }
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif;
            background: var(--bg); color: var(--text); min-height: 100dvh;
            display: flex; align-items: center; justify-content: center;
            /* 刘海屏与 Home 指示条：viewport-fit=cover 之后必须由内边距让位 */
            padding: max(20px, env(safe-area-inset-top)) max(20px, env(safe-area-inset-right))
                     max(20px, env(safe-area-inset-bottom)) max(20px, env(safe-area-inset-left));
        }
        .container {
            width: 100%; max-width: 560px; background: var(--panel);
            border: 1px solid var(--border); border-radius: 16px;
            padding: 24px;
            /* 与 body 同理：内容本身也要避开刘海与 Home 指示条 */
            padding-top: max(24px, env(safe-area-inset-top));
            padding-bottom: max(24px, env(safe-area-inset-bottom));
            box-shadow: inset 0 1px var(--inner-light), 0 20px 48px rgba(35,27,21,.21);
            backdrop-filter: blur(23px) saturate(118%); -webkit-backdrop-filter: blur(23px) saturate(118%);
        }
        .title { font-size: 14px; font-weight: 600; color: var(--text-secondary); margin-bottom: 15px; }
        .content {
            background: linear-gradient(180deg,var(--input-top),var(--input-bottom)); border: 1px solid var(--border); border-radius: 9px;
            box-shadow: inset 0 1px 2px var(--inner-dark), inset 0 -1px var(--inner-light);
            padding: 16px; font-family: 'SF Mono', Menlo, monospace; font-size: 14px; line-height: 1.7;
            /* 按词/标点断行；只有链接、哈希这类超长不可断的词才强制折断。
               旧代码用的是 word-break:break-all，普通英文单词也会被从中间
               劈开（"whether the" 断成 "whet / her the"），长文读起来很费劲。 */
            white-space: pre-wrap; overflow-wrap: break-word; word-break: normal; tab-size: 2;
            max-height: min(60dvh, 460px); overflow-y: auto; overscroll-behavior: contain;
        }
        /* 非代码内容用界面字体而不是等宽字体：分享的多半是普通文字，等宽
           字体让中文与英文都更松散，长段落反而更难读。识别出语言时
           renderContent 会给容器加 .hljs，代码仍保持等宽。
           font-family:inherit 直接沿用 body 的字体栈，不再复写一份。 */
        .content:not(.hljs) { font-family: inherit; font-size: 15px; line-height: 1.75; }
        .btn {
            display: inline-flex; align-items: center; gap: 8px;
            min-height: 38px; padding: 7px 15px; background: linear-gradient(170deg,var(--control-top),var(--control-bottom)); color: var(--text);
            border: 1px solid var(--border); border-radius: 8px; font: inherit; font-size: 12px; font-weight: 600;
            box-shadow: inset 0 1px var(--inner-light); cursor: pointer; margin-top: 16px;
            transition: transform 110ms, border-color 140ms, background 140ms, box-shadow 140ms;
        }
        .btn:hover { transform: translateY(-1px); border-color: var(--focus); background: linear-gradient(170deg,var(--control-hover-top),var(--control-hover-bottom)); }
        .btn:active { transform: translateY(1px); background: linear-gradient(180deg,var(--control-pressed-top),var(--control-pressed-bottom)); box-shadow: var(--press-shadow); transition-duration: 35ms; }
        .btn:focus-visible, .pin-input:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
        .notice { font-size: 13px; color: var(--text-secondary); margin-top: 12px; }
        .error { text-align: center; color: var(--text-secondary); }
        .pin-form { display: flex; gap: 12px; flex-wrap: wrap; }
        .pin-input {
            flex: 1; min-width: 120px; padding: 10px 16px; font-size: 18px;
            text-align: center; letter-spacing: 8px; border: 1px solid var(--border);
            border-radius: 8px; background: linear-gradient(180deg,var(--input-top),var(--input-bottom)); color: var(--text);
            box-shadow: inset 0 1px 2px var(--inner-dark), inset 0 -1px var(--inner-light);
        }
        .pin-input:focus { border-color: var(--accent); }
        .msg { padding: 12px; border-radius: 8px; margin-top: 12px; font-size: 14px; }
        .msg.error-msg { border: 1px solid var(--border); background: var(--input-top); color: var(--accent); }
        .expired-mark { font-size: 32px; line-height: 1; color: var(--text-secondary); margin-bottom: 14px; }
        .error .btn { text-decoration: none; margin-top: 22px; }
        .pin-form .btn { margin-top: 0; }
        @media (max-width: 480px) { body { padding: 14px; } .container { padding: 20px 17px; } .pin-form .btn { min-height: 44px; } }
        @media (prefers-reduced-motion: reduce) { .btn { transition: none; } .btn:hover, .btn:active { transform: none; } }
        @media (prefers-reduced-transparency: reduce) { .container { background: var(--input-bottom); backdrop-filter: none; -webkit-backdrop-filter: none; } }
        @supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) { .container { background: var(--input-bottom); } }

        /* 代码高亮配色，复用页面既有变量以适配明暗主题 */
        .hljs { color: var(--text); background: transparent; }
        .hljs-comment, .hljs-quote { color: var(--text-muted); font-style: italic; }
        .hljs-keyword, .hljs-selector-tag, .hljs-literal, .hljs-doctag { color: var(--accent); }
        .hljs-string, .hljs-regexp, .hljs-addition { color: var(--code-string); }
        .hljs-number, .hljs-symbol, .hljs-bullet { color: var(--code-number); }
        .hljs-title, .hljs-title.function_, .hljs-section, .hljs-name { color: var(--code-title); }
        .hljs-attr, .hljs-attribute, .hljs-variable, .hljs-template-variable { color: var(--code-attr); }
        .hljs-type, .hljs-built_in, .hljs-class .hljs-title { color: var(--code-type); }
        .hljs-meta, .hljs-tag { color: var(--text-secondary); }
        .hljs-deletion { color: var(--code-deletion); }
        .hljs-emphasis { font-style: italic; }
        .hljs-strong { font-weight: 600; }
    </style>
    <link rel="stylesheet" href="/themes.css">
</head>
<body>
    <div class="container">
        ${!exists ? `
            <div class="error">
                <p class="expired-mark" aria-hidden="true">◇</p>
                <p>分享不存在或已过期</p>
                <a href="/" class="btn">返回首页</a>
            </div>
        ` : requirePin ? `
            <div class="title">此分享需要验证 PIN</div>
            <form class="pin-form" id="pinForm">
                <input type="text" class="pin-input" id="pinInput" maxlength="4" pattern="\\d{4}"
                       placeholder="••••" autocomplete="off" inputmode="numeric">
                <button type="submit" class="btn">验证</button>
            </form>
            <div id="errorMsg"></div>
        ` : `
            <div class="title">分享内容</div>
            <div class="content" id="content">加载中...</div>
            <button class="btn" id="copyBtn">复制内容</button>
            <p class="notice">此内容已从服务器删除</p>
        `}
    </div>
    <script src="/lib/highlight.min.js"></script>
    <script>
        // 使用分享码进行端到端解密
        const Crypto = {
            async deriveKey(code) {
                const enc = new TextEncoder();
                const keyMaterial = await crypto.subtle.importKey(
                    'raw', enc.encode(code + '-pabu-e2e'), 'PBKDF2', false, ['deriveKey']
                );
                return crypto.subtle.deriveKey(
                    { name: 'PBKDF2', salt: enc.encode('pabu-paste-v2'), iterations: 100000, hash: 'SHA-256' },
                    keyMaterial,
                    { name: 'AES-GCM', length: 256 },
                    false,
                    ['decrypt']
                );
            },
            async decrypt(encryptedBase64, code) {
                const key = await this.deriveKey(code);
                const combined = Uint8Array.from(atob(encryptedBase64), c => c.charCodeAt(0));
                const iv = combined.slice(0, 12);
                const data = combined.slice(12);
                const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
                return new TextDecoder().decode(decrypted);
            }
        };

        const code = '${code}';
        let decryptedText = '';

        // 语言识别：先用高精度签名判定明确语言，再用 hljs 自动识别兜底。
        // 分享内容多为短片段，hljs 的 relevance 在短文本上区分度不足，
        // 因此签名层优先，避免把 Python 片段判成 CSS 一类的误判。
        const CJK = /[\\u4e00-\\u9fff]/;
        const LANG_SIGNATURES = [
            ['python', [/^\\s*def\\s+\\w+\\s*\\(.*\\)\\s*(->[^:]*)?:/m, /^\\s*(from\\s+[\\w.]+\\s+)?import\\s+[\\w.,*\\s]+$/m, /\\bself\\.\\w+/, /^\\s*class\\s+\\w+.*:\\s*$/m, /\\bprint\\s*\\(/, /\\b(elif|None|True|False|__init__|__name__)\\b/]],
            ['javascript', [/\\b(const|let|var)\\s+\\w+\\s*=/, /\\bfunction\\s*\\w*\\s*\\(/, /=>/, /\\brequire\\s*\\(/, /\\bconsole\\.(log|error|warn)\\s*\\(/, /\\bexport\\s+(default|const|function)/]],
            ['go', [/^\\s*package\\s+\\w+\\s*$/m, /\\bfunc\\s+\\w*\\s*\\(/, /\\bfmt\\.(Println|Printf|Errorf)\\s*\\(/, /:=/]],
            ['rust', [/\\bfn\\s+\\w+\\s*\\(/, /\\blet\\s+mut\\s+/, /\\bprintln!\\s*\\(/, /\\buse\\s+std::/]],
            ['java', [/\\b(public|private|protected)\\s+(static\\s+)?(final\\s+)?\\w+[\\w<>\\[\\]]*\\s+\\w+\\s*\\(/, /System\\.out\\.print/]],
            ['csharp', [/using\\s+System[\\s;]/, /namespace\\s+\\w+/, /Console\\.WriteLine\\s*\\(/]],
            ['php', [/<\\?php/, /\\$\\w+\\s*=/]],
            ['sql', [/\\b(SELECT|INSERT\\s+INTO|UPDATE|DELETE\\s+FROM|CREATE\\s+TABLE)\\b/i, /\\bFROM\\s+\\w+/i]],
            ['bash', [/^\\s*#!\\/.*\\b(ba)?sh\\b/m, /^\\s*(sudo|apt|apt-get|yum|brew|cd|ls|rm|mkdir|chmod|chown|curl|wget|git|export)\\s/m, /\\$\\{?\\w+\\}?/]],
            ['json', [/^\\s*[{[][\\s\\S]*[}\\]]\\s*$/]],
            ['yaml', [/^\\s*[\\w-]+:\\s*.*$/m, /^\\s*-\\s+\\w+:/m]]
        ];

        function detectLanguage(text) {
            if (!text || !text.trim()) return null;
            if (CJK.test(text)) return null;
            for (const [lang, patterns] of LANG_SIGNATURES) {
                if (patterns.some(pattern => pattern.test(text))) {
                    return window.hljs && window.hljs.getLanguage(lang) ? lang : null;
                }
            }
            if (!window.hljs) return null;
            const auto = window.hljs.highlightAuto(text);
            return auto && auto.language ? auto.language : null;
        }

        function renderContent(text) {
            const target = document.getElementById('content');
            const language = window.hljs ? detectLanguage(text) : null;
            if (language) {
                try {
                    target.classList.add('hljs');
                    target.innerHTML = window.hljs.highlight(text, { language }).value;
                    return;
                } catch {
                    target.classList.remove('hljs');
                }
            }
            target.textContent = text;
        }

        async function showContent(encryptedContent) {
            try {
                decryptedText = await Crypto.decrypt(encryptedContent, code);
                renderContent(decryptedText);
                document.getElementById('copyBtn').onclick = () => {
                    navigator.clipboard.writeText(decryptedText).then(() => {
                        document.getElementById('copyBtn').textContent = '已复制';
                        setTimeout(() => { document.getElementById('copyBtn').textContent = '复制内容'; }, 2000);
                    });
                };
            } catch {
                document.getElementById('content').textContent = '解密失败';
            }
        }

        ${exists && !requirePin ? `
        fetch('/api/p/' + code, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
            .then(r => r.json())
            .then(data => {
                if (data.content) {
                    showContent(data.content);
                } else {
                    document.getElementById('content').textContent = data.error || '获取失败';
                }
            })
            .catch(() => { document.getElementById('content').textContent = '获取失败'; });
        ` : ''}
        ${exists && requirePin ? `
        document.getElementById('pinForm').onsubmit = async (e) => {
            e.preventDefault();
            const pin = document.getElementById('pinInput').value;
            if (!/^\\d{4}$/.test(pin)) return;

            try {
                const res = await fetch('/api/p/' + code, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ pin })
                });
                const data = await res.json();

                if (data.content) {
                    document.querySelector('.container').innerHTML =
                        '<div class="title">分享内容</div>' +
                        '<div class="content" id="content">解密中...</div>' +
                        '<button class="btn" id="copyBtn">复制内容</button>' +
                        '<p class="notice">此内容已从服务器删除</p>';
                    showContent(data.content);
                } else {
                    // 用 textContent 而非拼接 innerHTML：不必依赖「服务端错误文案恒为
                    // 固定字符串」这一隐含前提，将来任何把用户输入拼进 error 的改动
                    // 都不会因此变成 XSS
                    const errorBox = document.getElementById('errorMsg');
                    const msg = document.createElement('div');
                    msg.className = 'msg error-msg';
                    msg.textContent = data.error || '验证失败';
                    errorBox.replaceChildren(msg);
                    if (data.error && data.error.includes('销毁')) {
                        document.getElementById('pinForm').style.display = 'none';
                    }
                }
            } catch {
                document.getElementById('errorMsg').innerHTML = '<div class="msg error-msg">请求失败</div>';
            }
        };
        ` : ''}
    </script>
</body>
</html>`;

    res.type('html').send(html);
});

function createServer() {
    if (config.server.https.enabled) {
        const https = require('https');
        const httpsOptions = {
            key: fsSync.readFileSync(config.server.https.keyPath),
            cert: fsSync.readFileSync(config.server.https.certPath)
        };
        if (config.server.https.caPath && fsSync.existsSync(config.server.https.caPath)) {
            httpsOptions.ca = fsSync.readFileSync(config.server.https.caPath);
        }
        return https.createServer(httpsOptions, app);
    }
    return http.createServer(app);
}

function gracefulShutdown(signal) {
    console.log(`\n${signal} received, shutting down gracefully...`);
    // 关库会把 WAL 合并回主文件（checkpoint），于是升级/备份只需处理一个 .db 文件。
    if (db) {
        try {
            db.close();
        } catch (err) {
            console.error('关闭数据库失败:', err.message);
        }
        db = null;
    }
    if (server) {
        server.close(() => {
            console.log('Server closed');
            process.exit(0);
        });
        setTimeout(() => {
            console.error('Forced shutdown after timeout');
            process.exit(1);
        }, 10000);
    } else {
        process.exit(0);
    }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

init().then(() => {
    config.validate();

    server = createServer();
    const HOST = config.server.host;
    const PORT = config.server.port;
    const protocol = config.server.https.enabled ? 'https' : 'http';

    server.listen(PORT, HOST, () => {
        console.log(`
┌─────────────────────────────────────────┐
│           Pabu Server              │
├─────────────────────────────────────────┤
│  URL:      ${protocol}://${HOST}:${PORT}`.padEnd(43) + `│
│  HTTPS:    ${config.server.https.enabled ? 'Enabled' : 'Disabled'}`.padEnd(43) + `│
│  Logs:     ${path.relative(config.rootDir, config.paths.logs) || 'logs/'}`.padEnd(43) + `│
└─────────────────────────────────────────┘
`);
    });
}).catch(err => {
    console.error('启动失败:', err);
    // 开库或迁移失败时连接可能已经建立：先关库再退出，避免留下未 checkpoint 的 WAL。
    if (db) {
        try { db.close(); } catch { /* 关不掉也要退出 */ }
        db = null;
    }
    process.exit(1);
});

module.exports = app;

setInterval(() => {
    const now = Date.now();
    cleanExpiredPastes();
    for (const [store, windowMs] of [
        [pasteRateLimitMap, PASTE_RATE_WINDOW], [rateLimitMap, RATE_LIMIT_WINDOW],
        [publicReadLimitMap, PUBLIC_READ_WINDOW], [globalLoginMap, 60000],
        [loginFailMap, LOGIN_FAIL_WINDOW], [syncReadLimitMap, SYNC_READ_WINDOW],
        [syncUploadLimitMap, SYNC_UPLOAD_WINDOW], [syncConnectLimitMap, SYNC_CONNECT_WINDOW],
        [syncIssueLimitMap, SYNC_ISSUE_WINDOW]
    ]) sweepRateLimitStore(store, now, windowMs);
    sessionStore?.sweep(now);
    syncStore?.sweep();
}, 60000).unref();
