import { Hono } from 'hono';
import type { AppEnv } from '../../src/types';

/**
 * CDP (Chrome DevTools Protocol) Info Endpoint for Self-hosted
 * 
 * Provides information about how to connect to Docker Chrome.
 * Direct CDP WebSocket connections should go through the Tunnel to Chrome container.
 * 
 * Architecture:
 *   Client → CF Tunnel → Docker Chrome (port 3000)
 *   (Not through Worker, direct WebSocket to Chrome)
 */
const cdpSelfhosted = new Hono<AppEnv>();

/**
 * GET /cdp - CDP connection info
 * 
 * Returns information about how to connect to Docker Chrome.
 * For WebSocket connections, connect directly to the Chrome container through Tunnel.
 */
cdpSelfhosted.get('/', async (c) => {
    const selfHostedUrl = c.env.SELFHOSTED_URL || 'http://localhost:3000';

    // Convert to WebSocket URL
    const wsUrl = selfHostedUrl
        .replace('https://', 'wss://')
        .replace('http://', 'ws://');

    return c.json({
        service: 'CDP Proxy to Docker Chrome',
        description: 'Connect directly to Chrome via WebSocket through Cloudflare Tunnel',
        endpoints: {
            websocket: `${wsUrl}/`,
            json_version: `${selfHostedUrl}/json/version`,
            json_list: `${selfHostedUrl}/json`,
            json_new: `${selfHostedUrl}/json/new?about:blank`,
        },
        note: 'CDP WebSocket connections should go directly through the Tunnel to Chrome, not through this Worker endpoint.',
    });
});

/**
 * GET /cdp/json/version - Proxy Chrome version info
 */
cdpSelfhosted.get('/json/version', async (c) => {
    const selfHostedUrl = c.env.SELFHOSTED_URL;
    if (!selfHostedUrl) {
        return c.json({ error: 'SELFHOSTED_URL not configured' }, 503);
    }

    try {
        // Chrome container port is 3000, but accessed via tunnel on main URL
        // Adjust URL if needed based on tunnel configuration
        const chromeUrl = selfHostedUrl.replace(':18789', ':3000');
        const response = await fetch(`${chromeUrl}/json/version`);
        const data = await response.json();
        return c.json(data);
    } catch (err) {
        return c.json({
            error: 'Failed to get Chrome version',
            details: err instanceof Error ? err.message : 'Unknown error',
            hint: 'Ensure Chrome container is running and tunnel is configured for port 3000',
        }, 502);
    }
});

/**
 * GET /cdp/json - Proxy list of available targets
 */
cdpSelfhosted.get('/json', async (c) => {
    const selfHostedUrl = c.env.SELFHOSTED_URL;
    if (!selfHostedUrl) {
        return c.json({ error: 'SELFHOSTED_URL not configured' }, 503);
    }

    try {
        const chromeUrl = selfHostedUrl.replace(':18789', ':3000');
        const response = await fetch(`${chromeUrl}/json`);
        const data = await response.json();
        return c.json(data);
    } catch (err) {
        return c.json({
            error: 'Failed to list targets',
            details: err instanceof Error ? err.message : 'Unknown error',
        }, 502);
    }
});

/**
 * GET /cdp/json/new - Proxy create new target
 */
cdpSelfhosted.get('/json/new', async (c) => {
    const selfHostedUrl = c.env.SELFHOSTED_URL;
    if (!selfHostedUrl) {
        return c.json({ error: 'SELFHOSTED_URL not configured' }, 503);
    }

    const url = new URL(c.req.url);
    const targetUrl = url.searchParams.get('url') || 'about:blank';

    try {
        const chromeUrl = selfHostedUrl.replace(':18789', ':3000');
        const response = await fetch(`${chromeUrl}/json/new?${encodeURIComponent(targetUrl)}`);
        const data = await response.json();
        return c.json(data);
    } catch (err) {
        return c.json({
            error: 'Failed to create target',
            details: err instanceof Error ? err.message : 'Unknown error',
        }, 502);
    }
});

export { cdpSelfhosted };
