# Moltbot Self-hosted on Cloudflare Workers

Self-hosted Moltbot AI assistant via Cloudflare Tunnel. No Cloudflare Sandbox, Browser Rendering, or R2 storage needed.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Starktomy/moltworker-self)

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│ Public Internet                                                     │
│                                                                     │
│   User → Worker URL → CF Access (SSO) → Tunnel (internal)          │
│                                           │                         │
└───────────────────────────────────────────│─────────────────────────┘
                                            ▼
┌─────────────────────────────────────────────────────────────────────┐
│ Your Server (Docker, no ports exposed)                             │
│                                                                     │
│   cloudflared → moltbot:18789 → chrome:3000                        │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

**Security Layers:**
1. Cloudflare Access - SSO authentication
2. Tunnel internal URL - No public hostname
3. Gateway Token - API validation
4. Docker network isolation - No exposed ports

## Prerequisites

- **Cloudflare Account** (free plan works for Worker + Tunnel)
- **Linux Server** with Docker & Docker Compose
- **Cloudflare Tunnel** created and running on your server

## Quick Start

### Step 1: Create Tunnel (No Public Hostname)

```bash
# Install cloudflared
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o cloudflared.deb
sudo dpkg -i cloudflared.deb

# Login and create tunnel
cloudflared tunnel login
cloudflared tunnel create moltbot-tunnel

# Get Tunnel Token (for Docker)
cloudflared tunnel token moltbot-tunnel
# Save: eyJhIjoiYWJjZGVmLi4uIn0=

# Get Tunnel ID (for Worker)
cloudflared tunnel info moltbot-tunnel
# Note: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

> ⚠️ **Important**: Do NOT add a Public Hostname in Cloudflare Dashboard. The Tunnel should only be accessible via Worker.

### Step 2: Deploy Docker Services

```bash
cd selfhosted
cp .env.example .env
# Edit .env with your values

docker-compose up -d
```

Required `.env` values:
```bash
ANTHROPIC_API_KEY=sk-ant-xxx
MOLTBOT_GATEWAY_TOKEN=your-random-token  # openssl rand -hex 32
CLOUDFLARE_TUNNEL_TOKEN=eyJhIjoiYWJjZGVmLi4uIn0=
```

### Step 3: Deploy Worker (One-Click)

Click the Deploy button above, or manually:

```bash
npm install
npm run deploy
```

### Step 4: Configure Worker Secrets

During Deploy Button setup, or manually:

```bash
# Tunnel internal URL
wrangler secret put SELFHOSTED_URL
# Enter: https://xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx.cfargotunnel.com

# Gateway token (same as .env)
wrangler secret put MOLTBOT_GATEWAY_TOKEN

# Access team domain
wrangler secret put CF_ACCESS_TEAM_DOMAIN
# Enter: myteam.cloudflareaccess.com

# Access application AUD
wrangler secret put CF_ACCESS_AUD
```

### Step 5: Configure Cloudflare Access

1. Go to [Zero Trust Dashboard](https://one.dash.cloudflare.com/)
2. Access → Applications → Add Application
3. Select **Self-hosted**
4. Application domain: `moltbot-selfhosted.<your-name>.workers.dev`
5. Configure SSO (Google, GitHub, etc.)
6. Copy **AUD Tag** for Step 4

## Usage

Access your Moltbot:
```
https://moltbot-selfhosted.<your-name>.workers.dev/?token=YOUR_GATEWAY_TOKEN
```

## Secrets Reference

| Secret | Required | Description |
|--------|----------|-------------|
| `SELFHOSTED_URL` | ✅ | Tunnel internal URL: `https://<tunnel-id>.cfargotunnel.com` |
| `MOLTBOT_GATEWAY_TOKEN` | ✅ | Gateway access token |
| `CF_ACCESS_TEAM_DOMAIN` | ✅ | Your Access team domain |
| `CF_ACCESS_AUD` | ✅ | Access application AUD tag |
| `CDP_SECRET` | ❌ | Optional: CDP endpoint secret |
| `DEBUG_ROUTES` | ❌ | Set to `true` to enable debug routes |

## Docker Services

| Service | Internal Port | Description |
|---------|---------------|-------------|
| moltbot | 18789 | AI Gateway |
| chrome | 3000 | Browser CDP |
| cloudflared | - | Tunnel client |

## Operations

```bash
# View logs
docker-compose logs -f moltbot

# Restart
docker-compose restart moltbot

# Stop
docker-compose down

# Start
docker-compose up -d
```

## Backup & Restore

```bash
# Backup
docker run --rm -v moltbot-config:/data -v $(pwd):/backup \
  alpine tar czf /backup/backup.tar.gz /data

# Restore
docker run --rm -v moltbot-config:/data -v $(pwd):/backup \
  alpine tar xzf /backup/backup.tar.gz
```

## Full Documentation

See [selfhosted/README.md](./selfhosted/README.md) for complete deployment guide including:
- Detailed tunnel configuration
- Cloudflare Access setup
- Troubleshooting guide
- Security model explanation
