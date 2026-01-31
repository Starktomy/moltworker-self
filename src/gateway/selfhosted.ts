/**
 * Self-hosted Gateway Client
 * 
 * Handles communication between Cloudflare Worker and self-hosted Moltbot server.
 * Supports HTTP proxying and WebSocket connections via Cloudflare Tunnel.
 */

import type { MoltbotEnv } from '../types';

export interface SelfHostedConfig {
    /** Base URL of the self-hosted server (e.g., https://moltbot-tunnel.example.com) */
    baseUrl: string;
    /** WebSocket URL (defaults to baseUrl with wss:// protocol) */
    wsUrl: string;
    /** Internal authentication token */
    authToken?: string;
}

/**
 * Build self-hosted configuration from environment
 */
export function buildSelfHostedConfig(env: MoltbotEnv): SelfHostedConfig | null {
    if (env.DEPLOYMENT_MODE !== 'selfhosted' || !env.SELFHOSTED_URL) {
        return null;
    }

    const baseUrl = env.SELFHOSTED_URL.replace(/\/$/, ''); // Remove trailing slash

    // Build WebSocket URL
    let wsUrl = env.SELFHOSTED_WS_URL;
    if (!wsUrl) {
        const url = new URL(baseUrl);
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        wsUrl = url.toString().replace(/\/$/, '');
    }

    return {
        baseUrl,
        wsUrl,
        authToken: env.SELFHOSTED_AUTH_TOKEN,
    };
}

/**
 * Check if self-hosted server is healthy
 */
export async function checkSelfHostedHealth(config: SelfHostedConfig): Promise<boolean> {
    try {
        const response = await fetch(`${config.baseUrl}/health`, {
            method: 'GET',
            headers: buildAuthHeaders(config),
            signal: AbortSignal.timeout(5000),
        });
        return response.ok;
    } catch (err) {
        console.error('[SelfHosted] Health check failed:', err);
        return false;
    }
}

/**
 * Build authentication headers for self-hosted requests
 */
function buildAuthHeaders(config: SelfHostedConfig): Headers {
    const headers = new Headers();
    if (config.authToken) {
        headers.set('X-Internal-Auth', config.authToken);
    }
    return headers;
}

/**
 * Proxy HTTP request to self-hosted server
 */
export async function proxySelfHostedRequest(
    config: SelfHostedConfig,
    request: Request
): Promise<Response> {
    const url = new URL(request.url);
    const targetUrl = new URL(url.pathname + url.search, config.baseUrl);

    console.log('[SelfHosted] Proxying HTTP:', request.method, targetUrl.pathname);

    // Build headers, preserving original headers and adding auth
    const headers = new Headers(request.headers);
    if (config.authToken) {
        headers.set('X-Internal-Auth', config.authToken);
    }
    // Remove host header to avoid conflicts
    headers.delete('host');

    // Forward cookies from original request
    const cookies = request.headers.get('Cookie');
    if (cookies) {
        headers.set('Cookie', cookies);
    }

    try {
        const response = await fetch(targetUrl.toString(), {
            method: request.method,
            headers,
            body: request.body,
            redirect: 'manual',
        });

        console.log('[SelfHosted] Response status:', response.status);

        // Clone response with debug headers
        const newHeaders = new Headers(response.headers);
        newHeaders.set('X-Worker-Debug', 'proxy-to-selfhosted');
        newHeaders.set('X-Debug-Path', url.pathname);

        return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: newHeaders,
        });
    } catch (err) {
        console.error('[SelfHosted] Proxy error:', err);
        return new Response(JSON.stringify({
            error: 'Failed to connect to self-hosted server',
            details: err instanceof Error ? err.message : 'Unknown error',
        }), {
            status: 502,
            headers: { 'Content-Type': 'application/json' },
        });
    }
}

/**
 * Proxy WebSocket connection to self-hosted server
 * 
 * Note: This uses Cloudflare Workers WebSocket API which differs from standard WebSocket.
 * The WebSocketPair and Response.webSocket are Cloudflare-specific extensions.
 */
export async function proxySelfHostedWebSocket(
    config: SelfHostedConfig,
    request: Request,
    transformMessage?: (data: string, host: string) => string
): Promise<Response> {
    const url = new URL(request.url);
    const targetUrl = new URL(url.pathname + url.search, config.wsUrl);

    console.log('[SelfHosted] Proxying WebSocket:', targetUrl.pathname);

    try {
        // Create WebSocket pair for client (Cloudflare Workers API)
        const webSocketPair = new WebSocketPair();
        const [clientWs, serverWs] = Object.values(webSocketPair);

        // Build upgrade headers for backend connection
        const upgradeHeaders = new Headers(request.headers);
        if (config.authToken) {
            upgradeHeaders.set('X-Internal-Auth', config.authToken);
        }

        // Connect to self-hosted server via fetch with WebSocket upgrade
        const backendResponse = await fetch(targetUrl.toString(), {
            headers: upgradeHeaders,
        });

        // Check if WebSocket upgrade was successful
        if (backendResponse.status !== 101) {
            console.error('[SelfHosted] WebSocket upgrade failed:', backendResponse.status);
            return new Response('WebSocket upgrade failed', { status: 502 });
        }

        // Get the backend WebSocket from response (Cloudflare-specific)
        const backendWs = (backendResponse as Response & { webSocket?: WebSocket }).webSocket;
        if (!backendWs) {
            console.error('[SelfHosted] No WebSocket in backend response');
            return new Response('WebSocket not available', { status: 502 });
        }

        // Accept both WebSockets
        serverWs.accept();
        backendWs.accept();

        console.log('[SelfHosted] WebSocket connections established');

        // Relay messages from client to backend
        serverWs.addEventListener('message', (event: MessageEvent) => {
            console.log('[SelfHosted WS] Client -> Backend:', typeof event.data);
            if (backendWs.readyState === WebSocket.OPEN) {
                backendWs.send(event.data);
            }
        });

        // Relay messages from backend to client, with optional transformation
        backendWs.addEventListener('message', (event: MessageEvent) => {
            console.log('[SelfHosted WS] Backend -> Client:', typeof event.data);
            let data = event.data;

            // Apply message transformation if provided
            if (typeof data === 'string' && transformMessage) {
                data = transformMessage(data, url.host);
            }

            if (serverWs.readyState === WebSocket.OPEN) {
                serverWs.send(data);
            }
        });

        // Handle close events
        serverWs.addEventListener('close', (event: CloseEvent) => {
            console.log('[SelfHosted WS] Client closed:', event.code, event.reason);
            backendWs.close(event.code, event.reason);
        });

        backendWs.addEventListener('close', (event: CloseEvent) => {
            console.log('[SelfHosted WS] Backend closed:', event.code, event.reason);
            serverWs.close(event.code, event.reason);
        });

        // Handle errors
        serverWs.addEventListener('error', (event: Event) => {
            console.error('[SelfHosted WS] Client error:', event);
            backendWs.close(1011, 'Client error');
        });

        backendWs.addEventListener('error', (event: Event) => {
            console.error('[SelfHosted WS] Backend error:', event);
            serverWs.close(1011, 'Backend error');
        });

        // Return WebSocket response (Cloudflare-specific)
        return new Response(null, {
            status: 101,
            // @ts-expect-error - webSocket is a Cloudflare Workers extension
            webSocket: clientWs,
        });
    } catch (err) {
        console.error('[SelfHosted] WebSocket proxy error:', err);
        return new Response(JSON.stringify({
            error: 'Failed to establish WebSocket connection',
            details: err instanceof Error ? err.message : 'Unknown error',
        }), {
            status: 502,
            headers: { 'Content-Type': 'application/json' },
        });
    }
}

/**
 * Execute a command on the self-hosted server via API
 * This replaces sandbox.startProcess() for self-hosted mode
 */
export async function executeSelfHostedCommand(
    config: SelfHostedConfig,
    command: string,
    timeoutMs: number = 20000
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    console.log('[SelfHosted] Executing command:', command);

    try {
        const response = await fetch(`${config.baseUrl}/api/internal/exec`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(config.authToken ? { 'X-Internal-Auth': config.authToken } : {}),
            },
            body: JSON.stringify({ command, timeout: timeoutMs }),
            signal: AbortSignal.timeout(timeoutMs + 5000),
        });

        if (!response.ok) {
            const text = await response.text();
            throw new Error(`Command execution failed: ${response.status} ${text}`);
        }

        return await response.json();
    } catch (err) {
        console.error('[SelfHosted] Command execution error:', err);
        throw err;
    }
}
