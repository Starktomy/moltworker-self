/**
 * Moltbot + Self-hosted Server (Full Self-hosted Mode)
 *
 * This Worker connects to a self-hosted Moltbot server via Cloudflare Tunnel.
 * - Data is persisted in Docker volumes on the server (no R2)
 * - Browser automation uses Docker Chrome (no CF Browser Rendering)
 *
 * Features:
 * - Web UI (Control Dashboard + WebChat) at /
 * - WebSocket support for real-time communication
 * - Admin UI at /_admin/ for device management
 * - CDP proxy to Docker Chrome browser
 *
 * Required secrets (set via `wrangler secret put`):
 * - SELFHOSTED_URL: URL of your self-hosted Moltbot (via Cloudflare Tunnel)
 * - MOLTBOT_GATEWAY_TOKEN: Gateway access token
 * - CF_ACCESS_TEAM_DOMAIN: Your Cloudflare Access team domain
 * - CF_ACCESS_AUD: Your Cloudflare Access application AUD
 *
 * Optional secrets:
 * - SELFHOSTED_AUTH_TOKEN: Internal authentication token
 * - CDP_SECRET: Shared secret for CDP endpoint
 * - DEV_MODE: Set to 'true' for local development
 */

import { Hono } from 'hono';

import type { AppEnv, MoltbotEnv } from '../src/types';
import { createAccessMiddleware } from '../src/auth';
import {
    buildSelfHostedConfig,
    checkSelfHostedHealth,
    proxySelfHostedRequest,
    proxySelfHostedWebSocket,
} from '../src/gateway';
import { adminUi, debug } from '../src/routes';
import { publicRoutes } from './routes/public.selfhosted';
import { api } from './routes/api.selfhosted';
import { cdpSelfhosted } from './routes/cdp.selfhosted';
import loadingPageHtml from '../src/assets/loading.html';
import configErrorHtml from '../src/assets/config-error.html';

/**
 * Transform error messages from the gateway to be more user-friendly.
 */
function transformErrorMessage(message: string, host: string): string {
    if (message.includes('gateway token missing') || message.includes('gateway token mismatch')) {
        return `Invalid or missing token. Visit https://${host}?token={REPLACE_WITH_YOUR_TOKEN}`;
    }

    if (message.includes('pairing required')) {
        return `Pairing required. Visit https://${host}/_admin/`;
    }

    return message;
}

/**
 * Validate required environment variables for self-hosted mode.
 */
function validateRequiredEnv(env: MoltbotEnv): string[] {
    const missing: string[] = [];

    if (!env.SELFHOSTED_URL) {
        missing.push('SELFHOSTED_URL');
    }

    if (!env.MOLTBOT_GATEWAY_TOKEN) {
        missing.push('MOLTBOT_GATEWAY_TOKEN');
    }

    if (!env.CF_ACCESS_TEAM_DOMAIN) {
        missing.push('CF_ACCESS_TEAM_DOMAIN');
    }

    if (!env.CF_ACCESS_AUD) {
        missing.push('CF_ACCESS_AUD');
    }

    return missing;
}

// Main app
const app = new Hono<AppEnv>();

// =============================================================================
// MIDDLEWARE
// =============================================================================

// Middleware: Log every request
app.use('*', async (c, next) => {
    const url = new URL(c.req.url);
    console.log(`[REQ] ${c.req.method} ${url.pathname}${url.search}`);
    console.log(`[REQ] Mode: self-hosted (Docker Chrome + Docker volumes)`);
    await next();
});

// =============================================================================
// PUBLIC ROUTES (no auth required)
// =============================================================================

app.route('/', publicRoutes);

// CDP routes - proxies to Docker Chrome (uses secret-based auth, not CF Access)
app.route('/cdp', cdpSelfhosted);

// =============================================================================
// PROTECTED ROUTES (Cloudflare Access required)
// =============================================================================

// Middleware: Validate required environment variables
app.use('*', async (c, next) => {
    const url = new URL(c.req.url);

    if (url.pathname.startsWith('/debug')) {
        return next();
    }

    if (c.env.DEV_MODE === 'true') {
        return next();
    }

    const missingVars = validateRequiredEnv(c.env);
    if (missingVars.length > 0) {
        console.error('[CONFIG] Missing:', missingVars.join(', '));

        const acceptsHtml = c.req.header('Accept')?.includes('text/html');
        if (acceptsHtml) {
            const html = configErrorHtml.replace('{{MISSING_VARS}}', missingVars.join(', '));
            return c.html(html, 503);
        }

        return c.json({
            error: 'Configuration error',
            missing: missingVars,
        }, 503);
    }

    return next();
});

// Middleware: Cloudflare Access authentication
app.use('*', async (c, next) => {
    const acceptsHtml = c.req.header('Accept')?.includes('text/html');
    const middleware = createAccessMiddleware({
        type: acceptsHtml ? 'html' : 'json',
        redirectOnMissing: acceptsHtml
    });
    return middleware(c, next);
});

app.route('/api', api);
app.route('/_admin', adminUi);

app.use('/debug/*', async (c, next) => {
    if (c.env.DEBUG_ROUTES !== 'true') {
        return c.json({ error: 'Debug routes are disabled' }, 404);
    }
    return next();
});
app.route('/debug', debug);

// =============================================================================
// CATCH-ALL: Proxy to self-hosted server
// =============================================================================

app.all('*', async (c) => {
    const request = c.req.raw;
    const url = new URL(request.url);

    const config = buildSelfHostedConfig(c.env);
    if (!config) {
        return c.json({
            error: 'Self-hosted configuration missing',
            hint: 'Set SELFHOSTED_URL via wrangler secret put',
        }, 503);
    }

    const isGatewayReady = await checkSelfHostedHealth(config);
    const isWebSocketRequest = request.headers.get('Upgrade')?.toLowerCase() === 'websocket';
    const acceptsHtml = request.headers.get('Accept')?.includes('text/html');

    if (!isGatewayReady && !isWebSocketRequest && acceptsHtml) {
        return c.html(loadingPageHtml);
    }

    if (!isGatewayReady) {
        return c.json({
            error: 'Self-hosted Moltbot gateway is not responding',
            hint: 'Check that your server is running',
        }, 503);
    }

    if (isWebSocketRequest) {
        return proxySelfHostedWebSocket(config, request, (message, host) => {
            try {
                const parsed = JSON.parse(message);
                if (parsed.error?.message) {
                    parsed.error.message = transformErrorMessage(parsed.error.message, host);
                    return JSON.stringify(parsed);
                }
            } catch {
                // Not JSON
            }
            return message;
        });
    }

    return proxySelfHostedRequest(config, request);
});

export default {
    fetch: app.fetch,
};
