'use strict';

const { iconNotModified } = require('./icon-service');

function createIconHandler(iconService, resolveClientIp = req => req.ip || req.socket?.remoteAddress || 'unknown') {
    return async (req, res) => {
        const rawUrl = req.query?.url;
        if (!rawUrl || typeof rawUrl !== 'string') return res.status(400).json({ error: '请提供有效的网址参数' });
        const origin = iconService.canonicalOrigin(rawUrl);
        if (!origin) return res.status(400).json({ error: '无效或不受支持的网址' });
        const budget = iconService.checkRequestBudget(resolveClientIp(req), origin);
        const retry = (status, message, seconds) => {
            res.setHeader('Cache-Control', 'no-store');
            res.setHeader('Retry-After', String(seconds));
            return res.status(status).json({ error: message });
        };
        if (!budget.allowed) return retry(budget.status, '请求过于频繁，请稍后再试', 60);

        const controller = new AbortController();
        const abortIfClosed = () => { if (!res.writableEnded) controller.abort(); };
        req.once('aborted', abortIfClosed);
        res.once('close', abortIfClosed);
        const sendIcon = image => {
            if (!image?.data) return retry(404, '未获取到网站图标', 300);
            res.setHeader('Content-Type', image.contentType);
            res.setHeader('Cache-Control', 'private, max-age=86400');
            res.setHeader('X-Content-Type-Options', 'nosniff');
            res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
            res.setHeader('ETag', image.etag);
            res.setHeader('X-Pabu-Icon-Source', image.source || 'unknown');
            res.setHeader('X-Pabu-Icon-Validated-At', new Date(image.validatedAt).toISOString());
            res.setHeader('X-Pabu-Icon-Stale', image.stale ? 'true' : 'false');
            if (iconNotModified(image, req.headers['if-none-match'])) return res.status(304).end();
            return res.send(image.data);
        };

        try {
            if (req.query.refresh === '1') {
                const result = await iconService.refreshIcon(origin, { waitMs: 20000, signal: controller.signal });
                if (result.status === 'ok') return sendIcon(result.icon);
                if (result.status === 'cooldown') return retry(429, '图标刷新过于频繁', Math.max(1, Math.ceil((result.retryAfterMs || iconService.refreshCooldownMs) / 1000)));
                if (result.status === 'timeout') return retry(504, '图标刷新超时', 5);
                if (result.status === 'failed') return retry(502, '图标刷新失败', 300);
                if (result.status === 'cancelled' || res.destroyed) return;
                return retry(503, '图标服务繁忙', 1);
            }
            return sendIcon(await iconService.getIcon(origin, { signal: controller.signal }));
        } catch (error) {
            if (error.code === 'client_closed' || res.destroyed) return;
            if (error.code === 'queue_full' || error.code === 'waiters_full' || error.code === 'queue_timeout') return retry(503, '图标服务繁忙', 1);
            if (error.code === 'job_timeout') return retry(504, '获取图标超时', 5);
            return retry(404, '未获取到网站图标', 300);
        } finally {
            req.off('aborted', abortIfClosed);
            res.off('close', abortIfClosed);
        }
    };
}

module.exports = { createIconHandler };
