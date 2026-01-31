import { Hono } from 'hono';
import type { AppEnv } from '../../src/types';
import { MOLTBOT_PORT } from '../../src/config';
import { buildSelfHostedConfig, checkSelfHostedHealth } from '../../src/gateway';

/**
 * Public routes - NO Cloudflare Access authentication required
 * 
 * These routes are mounted BEFORE the auth middleware is applied.
 * Includes: health checks, static assets, and public API endpoints.
 * 
 * Self-hosted version: Uses HTTP calls instead of Sandbox API.
 */
const publicRoutes = new Hono<AppEnv>();

// GET /sandbox-health - Health check endpoint (kept for compatibility)
publicRoutes.get('/sandbox-health', async (c) => {
    const config = buildSelfHostedConfig(c.env);

    if (config) {
        const isHealthy = await checkSelfHostedHealth(config);
        return c.json({
            status: isHealthy ? 'ok' : 'unhealthy',
            service: 'moltbot-selfhosted',
            gateway_port: MOLTBOT_PORT,
            selfhosted_url: config.baseUrl,
        });
    }

    return c.json({
        status: 'error',
        service: 'moltbot-selfhosted',
        error: 'Self-hosted configuration not found',
    }, 503);
});

// GET /logo.png - Serve logo from ASSETS binding
publicRoutes.get('/logo.png', (c) => {
    return c.env.ASSETS.fetch(c.req.raw);
});

// GET /logo-small.png - Serve small logo from ASSETS binding
publicRoutes.get('/logo-small.png', (c) => {
    return c.env.ASSETS.fetch(c.req.raw);
});

// GET /api/status - Public health check for gateway status (no auth required)
publicRoutes.get('/api/status', async (c) => {
    const config = buildSelfHostedConfig(c.env);

    if (!config) {
        return c.json({ ok: false, status: 'not_configured' });
    }

    try {
        const isHealthy = await checkSelfHostedHealth(config);

        if (isHealthy) {
            return c.json({
                ok: true,
                status: 'running',
                mode: 'selfhosted',
                url: config.baseUrl,
            });
        }

        return c.json({
            ok: false,
            status: 'not_responding',
            mode: 'selfhosted',
            url: config.baseUrl,
        });
    } catch (err) {
        return c.json({
            ok: false,
            status: 'error',
            error: err instanceof Error ? err.message : 'Unknown error'
        });
    }
});

// GET /_admin/assets/* - Admin UI static assets (CSS, JS need to load for login redirect)
// Assets are built to dist/client with base "/_admin/"
publicRoutes.get('/_admin/assets/*', async (c) => {
    const url = new URL(c.req.url);
    // Rewrite /_admin/assets/* to /assets/* for the ASSETS binding
    const assetPath = url.pathname.replace('/_admin/assets/', '/assets/');
    const assetUrl = new URL(assetPath, url.origin);
    return c.env.ASSETS.fetch(new Request(assetUrl.toString(), c.req.raw));
});

export { publicRoutes };
