import { Hono } from 'hono';
import type { AppEnv } from '../../src/types';
import { createAccessMiddleware } from '../../src/auth';
import { buildSelfHostedConfig, executeSelfHostedCommand, checkSelfHostedHealth } from '../../src/gateway';

// CLI commands can take 10-15 seconds to complete due to WebSocket connection overhead
const CLI_TIMEOUT_MS = 20000;

/**
 * API routes for Self-hosted Moltbot
 * - /api/admin/* - Protected admin API routes (Cloudflare Access required)
 * 
 * Note: /api/status is now handled by publicRoutes (no auth required)
 */
const api = new Hono<AppEnv>();

/**
 * Admin API routes - all protected by Cloudflare Access
 */
const adminApi = new Hono<AppEnv>();

// Middleware: Verify Cloudflare Access JWT for all admin routes
adminApi.use('*', createAccessMiddleware({ type: 'json' }));

// GET /api/admin/devices - List pending and paired devices
adminApi.get('/devices', async (c) => {
    const config = buildSelfHostedConfig(c.env);
    if (!config) {
        return c.json({ error: 'Self-hosted configuration missing' }, 503);
    }

    try {
        // Run moltbot CLI to list devices (CLI is still named clawdbot until upstream renames)
        const result = await executeSelfHostedCommand(
            config,
            'clawdbot devices list --json --url ws://localhost:18789',
            CLI_TIMEOUT_MS
        );

        const stdout = result.stdout || '';
        const stderr = result.stderr || '';

        // Try to parse JSON output
        try {
            // Find JSON in output (may have other log lines)
            const jsonMatch = stdout.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                const data = JSON.parse(jsonMatch[0]);
                return c.json(data);
            }

            // If no JSON found, return raw output for debugging
            return c.json({
                pending: [],
                paired: [],
                raw: stdout,
                stderr,
            });
        } catch {
            return c.json({
                pending: [],
                paired: [],
                raw: stdout,
                stderr,
                parseError: 'Failed to parse CLI output',
            });
        }
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        return c.json({ error: errorMessage }, 500);
    }
});

// POST /api/admin/devices/:requestId/approve - Approve a pending device
adminApi.post('/devices/:requestId/approve', async (c) => {
    const config = buildSelfHostedConfig(c.env);
    if (!config) {
        return c.json({ error: 'Self-hosted configuration missing' }, 503);
    }

    const requestId = c.req.param('requestId');
    if (!requestId) {
        return c.json({ error: 'requestId is required' }, 400);
    }

    try {
        // Run moltbot CLI to approve the device (CLI is still named clawdbot)
        const result = await executeSelfHostedCommand(
            config,
            `clawdbot devices approve ${requestId} --url ws://localhost:18789`,
            CLI_TIMEOUT_MS
        );

        const stdout = result.stdout || '';
        const stderr = result.stderr || '';

        // Check for success indicators (case-insensitive, CLI outputs "Approved ...")
        const success = stdout.toLowerCase().includes('approved') || result.exitCode === 0;

        return c.json({
            success,
            requestId,
            message: success ? 'Device approved' : 'Approval may have failed',
            stdout,
            stderr,
        });
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        return c.json({ error: errorMessage }, 500);
    }
});

// POST /api/admin/devices/approve-all - Approve all pending devices
adminApi.post('/devices/approve-all', async (c) => {
    const config = buildSelfHostedConfig(c.env);
    if (!config) {
        return c.json({ error: 'Self-hosted configuration missing' }, 503);
    }

    try {
        // First, get the list of pending devices
        const listResult = await executeSelfHostedCommand(
            config,
            'clawdbot devices list --json --url ws://localhost:18789',
            CLI_TIMEOUT_MS
        );

        const stdout = listResult.stdout || '';

        // Parse pending devices
        let pending: Array<{ requestId: string }> = [];
        try {
            const jsonMatch = stdout.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                const data = JSON.parse(jsonMatch[0]);
                pending = data.pending || [];
            }
        } catch {
            return c.json({ error: 'Failed to parse device list', raw: stdout }, 500);
        }

        if (pending.length === 0) {
            return c.json({ approved: [], message: 'No pending devices to approve' });
        }

        // Approve each pending device
        const results: Array<{ requestId: string; success: boolean; error?: string }> = [];

        for (const device of pending) {
            try {
                const approveResult = await executeSelfHostedCommand(
                    config,
                    `clawdbot devices approve ${device.requestId} --url ws://localhost:18789`,
                    CLI_TIMEOUT_MS
                );

                const success = approveResult.stdout?.toLowerCase().includes('approved') || approveResult.exitCode === 0;
                results.push({ requestId: device.requestId, success });
            } catch (err) {
                results.push({
                    requestId: device.requestId,
                    success: false,
                    error: err instanceof Error ? err.message : 'Unknown error',
                });
            }
        }

        const approvedCount = results.filter(r => r.success).length;
        return c.json({
            approved: results.filter(r => r.success).map(r => r.requestId),
            failed: results.filter(r => !r.success),
            message: `Approved ${approvedCount} of ${pending.length} device(s)`,
        });
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        return c.json({ error: errorMessage }, 500);
    }
});

// GET /api/admin/storage - Get R2 storage status and last sync time
adminApi.get('/storage', async (c) => {
    const config = buildSelfHostedConfig(c.env);
    if (!config) {
        return c.json({ error: 'Self-hosted configuration missing' }, 503);
    }

    const hasCredentials = !!(
        c.env.R2_ACCESS_KEY_ID &&
        c.env.R2_SECRET_ACCESS_KEY &&
        c.env.CF_ACCOUNT_ID
    );

    // Check which credentials are missing
    const missing: string[] = [];
    if (!c.env.R2_ACCESS_KEY_ID) missing.push('R2_ACCESS_KEY_ID');
    if (!c.env.R2_SECRET_ACCESS_KEY) missing.push('R2_SECRET_ACCESS_KEY');
    if (!c.env.CF_ACCOUNT_ID) missing.push('CF_ACCOUNT_ID');

    let lastSync: string | null = null;

    // If R2 is configured, check for last sync timestamp from server
    if (hasCredentials) {
        try {
            const result = await executeSelfHostedCommand(
                config,
                'cat /root/.clawdbot/.last-sync 2>/dev/null || echo ""',
                5000
            );
            const timestamp = result.stdout?.trim();
            if (timestamp && timestamp !== '') {
                lastSync = timestamp;
            }
        } catch {
            // Ignore errors checking sync status
        }
    }

    return c.json({
        configured: hasCredentials,
        missing: missing.length > 0 ? missing : undefined,
        lastSync,
        mode: 'selfhosted',
        message: hasCredentials
            ? 'R2 storage is configured. Your data will persist via rclone sync.'
            : 'R2 storage is not configured. Paired devices and conversations may be lost on server restart.',
    });
});

// POST /api/admin/storage/sync - Trigger a manual sync to R2
adminApi.post('/storage/sync', async (c) => {
    const config = buildSelfHostedConfig(c.env);
    if (!config) {
        return c.json({ error: 'Self-hosted configuration missing' }, 503);
    }

    try {
        // Call the internal sync endpoint on the self-hosted server
        const response = await fetch(`${config.baseUrl}/api/internal/sync`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(config.authToken ? { 'X-Internal-Auth': config.authToken } : {}),
            },
        });

        if (response.ok) {
            const result = await response.json() as { success: boolean; lastSync?: string; error?: string };
            return c.json({
                success: result.success,
                message: result.success ? 'Sync completed successfully' : 'Sync failed',
                lastSync: result.lastSync,
                error: result.error,
            });
        } else {
            const text = await response.text();
            return c.json({
                success: false,
                error: `Sync request failed: ${response.status}`,
                details: text,
            }, 500);
        }
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        return c.json({
            success: false,
            error: errorMessage,
        }, 500);
    }
});

// POST /api/admin/gateway/restart - Trigger gateway restart on self-hosted server
adminApi.post('/gateway/restart', async (c) => {
    const config = buildSelfHostedConfig(c.env);
    if (!config) {
        return c.json({ error: 'Self-hosted configuration missing' }, 503);
    }

    try {
        // Call the internal restart endpoint on the self-hosted server
        const response = await fetch(`${config.baseUrl}/api/internal/restart`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(config.authToken ? { 'X-Internal-Auth': config.authToken } : {}),
            },
        });

        if (response.ok) {
            const result = await response.json() as { success: boolean; message?: string; error?: string };
            return c.json({
                success: result.success,
                message: result.message || 'Gateway restart initiated',
            });
        } else {
            const text = await response.text();
            return c.json({
                success: false,
                error: `Restart request failed: ${response.status}`,
                details: text,
            }, 500);
        }
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        return c.json({ error: errorMessage }, 500);
    }
});

// GET /api/admin/server/status - Get self-hosted server status
adminApi.get('/server/status', async (c) => {
    const config = buildSelfHostedConfig(c.env);
    if (!config) {
        return c.json({ error: 'Self-hosted configuration missing' }, 503);
    }

    try {
        const isHealthy = await checkSelfHostedHealth(config);

        // Get more detailed status from internal API
        const response = await fetch(`${config.baseUrl}/api/internal/status`, {
            method: 'GET',
            headers: config.authToken ? { 'X-Internal-Auth': config.authToken } : {},
        });

        if (response.ok) {
            const status = await response.json() as { gateway: string; pid?: string; timestamp?: string };
            return c.json({
                healthy: isHealthy,
                gateway: status.gateway,
                pid: status.pid,
                timestamp: status.timestamp,
                url: config.baseUrl,
            });
        }

        return c.json({
            healthy: isHealthy,
            gateway: isHealthy ? 'running' : 'unknown',
            url: config.baseUrl,
        });
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        return c.json({
            healthy: false,
            gateway: 'error',
            error: errorMessage,
            url: config.baseUrl,
        });
    }
});

// Mount admin API routes under /admin
api.route('/admin', adminApi);

export { api };
