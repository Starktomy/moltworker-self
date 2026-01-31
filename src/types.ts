import type { Sandbox } from '@cloudflare/sandbox';

/**
 * Environment bindings for the Moltbot Worker
 */
export interface MoltbotEnv {
  Sandbox: DurableObjectNamespace<Sandbox>;
  ASSETS: Fetcher; // Assets binding for admin UI static files
  MOLTBOT_BUCKET: R2Bucket; // R2 bucket for persistent storage
  
  // AI Gateway configuration (preferred)
  AI_GATEWAY_API_KEY?: string; // API key for the provider configured in AI Gateway
  AI_GATEWAY_BASE_URL?: string; // AI Gateway URL (e.g., https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/anthropic)
  
  // Legacy direct provider configuration (fallback)
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_BASE_URL?: string;
  OPENAI_API_KEY?: string;
  MOLTBOT_GATEWAY_TOKEN?: string; // Gateway token (mapped to CLAWDBOT_GATEWAY_TOKEN for container)

  CLAWDBOT_BIND_MODE?: string;
  DEV_MODE?: string; // Set to 'true' for local dev (skips CF Access auth + moltbot device pairing)
  DEBUG_ROUTES?: string; // Set to 'true' to enable /debug/* routes
  SANDBOX_SLEEP_AFTER?: string; // How long before sandbox sleeps: 'never' (default), or duration like '10m', '1h'
  
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_DM_POLICY?: string;
  DISCORD_BOT_TOKEN?: string;
  DISCORD_DM_POLICY?: string;
  SLACK_BOT_TOKEN?: string;
  SLACK_APP_TOKEN?: string;
  
  // Cloudflare Access configuration for admin routes
  CF_ACCESS_TEAM_DOMAIN?: string; // e.g., 'myteam.cloudflareaccess.com'
  CF_ACCESS_AUD?: string; // Application Audience (AUD) tag
  
  // R2 credentials for bucket mounting (set via wrangler secret)
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  CF_ACCOUNT_ID?: string; // Cloudflare account ID for R2 endpoint
  
  // Browser Rendering binding for CDP shim
  BROWSER?: Fetcher;
  CDP_SECRET?: string; // Shared secret for CDP endpoint authentication
  WORKER_URL?: string; // Public URL of the worker (for CDP endpoint)

  // =============================================================================
  // SELF-HOSTED MODE CONFIGURATION
  // =============================================================================
  
  /**
   * Deployment mode: 'sandbox' (default) or 'selfhosted'
   * - sandbox: Use Cloudflare Sandbox containers
   * - selfhosted: Connect to self-hosted Moltbot server
   */
  DEPLOYMENT_MODE?: 'sandbox' | 'selfhosted';
  
  /**
   * Self-hosted server URL (required when DEPLOYMENT_MODE=selfhosted)
   * This should be the internal URL accessible via Cloudflare Tunnel
   * Example: https://moltbot-tunnel.example.com or http://moltbot:18789 (tunnel internal)
   */
  SELFHOSTED_URL?: string;
  
  /**
   * Internal authentication token for self-hosted server
   * Used to authenticate requests from Worker to self-hosted server
   */
  SELFHOSTED_AUTH_TOKEN?: string;
  
  /**
   * WebSocket URL for self-hosted server (optional, defaults to SELFHOSTED_URL with wss://)
   */
  SELFHOSTED_WS_URL?: string;
}

/**
 * Authenticated user from Cloudflare Access
 */
export interface AccessUser {
  email: string;
  name?: string;
}

/**
 * Hono app environment type
 */
export type AppEnv = {
  Bindings: MoltbotEnv;
  Variables: {
    sandbox: Sandbox;
    accessUser?: AccessUser;
    // For self-hosted mode, sandbox may be undefined
    isSelfHosted?: boolean;
  };
};

/**
 * JWT payload from Cloudflare Access
 */
export interface JWTPayload {
  aud: string[];
  email: string;
  exp: number;
  iat: number;
  iss: string;
  name?: string;
  sub: string;
  type: string;
}
