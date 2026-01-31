# Self-hosted Moltbot Deployment

Fully self-hosted Moltbot with Docker Chrome and Docker volumes.

## Architecture

```
Users → Cloudflare Worker → CF Tunnel → Your Server
              ↓                              ↓
         (Routing only)           ├── Moltbot Gateway
                                  ├── Chrome Browser (CDP)
                                  └── Docker Volumes (data)
```

**Cloudflare 云端**: Worker (路由/认证), Tunnel (安全通道), Access (SSO)  
**自建服务器**: Moltbot, Chrome, 数据存储

## Quick Start

### 1. Create Tunnel

```bash
cloudflared tunnel login
cloudflared tunnel create moltbot-tunnel
cloudflared tunnel token moltbot-tunnel  # Save this token
```

### 2. Configure Tunnel Route

In [Cloudflare Dashboard](https://one.dash.cloudflare.com/):
- Networks → Tunnels → Select tunnel
- Hostname: `moltbot.yourdomain.com` → `http://moltbot:18789`

### 3. Deploy Server

```bash
cd selfhosted
cp .env.example .env
# Edit .env

docker-compose up -d
```

### 4. Deploy Worker

```bash
npm run build
npx wrangler deploy --config wrangler.selfhosted.jsonc

# Set secrets
wrangler secret put SELFHOSTED_URL --config wrangler.selfhosted.jsonc
# Enter: https://moltbot.yourdomain.com

wrangler secret put MOLTBOT_GATEWAY_TOKEN --config wrangler.selfhosted.jsonc
wrangler secret put CF_ACCESS_TEAM_DOMAIN --config wrangler.selfhosted.jsonc
wrangler secret put CF_ACCESS_AUD --config wrangler.selfhosted.jsonc
```

## Services

| Service | Port | Description |
|---------|------|-------------|
| moltbot | 18789 | AI Gateway |
| chrome | 3000 | Browser (CDP) |
| cloudflared | - | Tunnel |

## Data Persistence

```bash
# Backup
docker run --rm -v moltbot-config:/data -v $(pwd):/backup \
  alpine tar czf /backup/backup.tar.gz /data

# Restore
docker run --rm -v moltbot-config:/data -v $(pwd):/backup \
  alpine tar xzf /backup/backup.tar.gz
```

## Commands

```bash
docker-compose logs -f moltbot   # View logs
docker-compose restart moltbot   # Restart
docker-compose down              # Stop
docker-compose up -d             # Start
```
