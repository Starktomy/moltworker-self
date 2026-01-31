# Self-hosted Moltbot 完整部署指南

Fully self-hosted Moltbot with Docker Chrome and Docker volumes.

---

## 目录

1. [架构概述](#架构概述)
2. [前置要求](#前置要求)
3. [Step 1: 创建 Cloudflare Tunnel](#step-1-创建-cloudflare-tunnel)
4. [Step 2: 配置 Cloudflare Access](#step-2-配置-cloudflare-access)
5. [Step 3: 部署 Docker 服务](#step-3-部署-docker-服务)
6. [Step 4: 部署 Cloudflare Worker](#step-4-部署-cloudflare-worker)
7. [Step 5: 验证部署](#step-5-验证部署)
8. [运维命令](#运维命令)
9. [故障排查](#故障排查)

---

## 架构概述

```
┌─────────────────────────────────────────────────────────────────────┐
│ Public Internet                                                     │
│                                                                     │
│   User → worker.example.workers.dev → CF Access (SSO required)     │
│                                           │                         │
└───────────────────────────────────────────│─────────────────────────┘
                                            ▼
┌─────────────────────────────────────────────────────────────────────┐
│ Cloudflare Internal Network                                         │
│                                                                     │
│   Worker → <tunnel-id>.cfargotunnel.com → Tunnel                   │
│            (内部地址，无公网入口)              │                      │
└──────────────────────────────────────────────│──────────────────────┘
                                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│ Your Server (Docker Network, no ports exposed)                     │
│                                                                     │
│   cloudflared ──→ moltbot:18789 ──→ chrome:3000                    │
│        │                │                 │                         │
│   (Tunnel客户端)    (AI Gateway)    (浏览器自动化)                    │
│                                                                     │
│   Volumes: moltbot-config, moltbot-workspace                       │
└─────────────────────────────────────────────────────────────────────┘
```

**安全层级**:
| 层级 | 保护机制 |
|------|---------|
| 1 | Cloudflare Access - SSO 登录认证 |
| 2 | Tunnel 内部地址 - 无公网域名入口 |
| 3 | Gateway Token - API 请求验证 |
| 4 | Docker 网络隔离 - 无端口暴露 |

---

## 前置要求

### 服务器要求
- Linux 服务器 (推荐 Ubuntu 22.04+)
- Docker & Docker Compose 已安装
- 至少 4GB 内存 (Chrome 需要较多内存)

### Cloudflare 账户
- Cloudflare 账户 (免费即可)
- 域名已托管在 Cloudflare (用于 Worker)
- Zero Trust 已启用

### 本地开发环境
- Node.js 18+
- npm 或 pnpm
- Wrangler CLI (`npm install -g wrangler`)
- Cloudflared CLI

---

## Step 1: 创建 Cloudflare Tunnel

### 1.1 安装 cloudflared

```bash
# Ubuntu/Debian
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o cloudflared.deb
sudo dpkg -i cloudflared.deb

# macOS
brew install cloudflared

# Windows (PowerShell)
winget install Cloudflare.cloudflared
```

### 1.2 登录 Cloudflare

```bash
cloudflared tunnel login
```

这会打开浏览器让你授权。

### 1.3 创建 Tunnel

```bash
# 创建隧道
cloudflared tunnel create moltbot-tunnel

# 输出类似:
# Tunnel credentials written to /home/user/.cloudflared/xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx.json
# Created tunnel moltbot-tunnel with id xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

### 1.4 获取 Tunnel 信息

```bash
# 获取 Tunnel Token (用于 docker-compose)
cloudflared tunnel token moltbot-tunnel
# 保存这个 Token，类似: eyJhIjoiYWJjZGVmLi4uIn0=

# 获取 Tunnel ID (用于 Worker 配置)
cloudflared tunnel info moltbot-tunnel
# 记录 Tunnel ID: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

### 1.5 配置 Tunnel 路由

创建配置文件 `~/.cloudflared/config.yml`:

```yaml
tunnel: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx  # 你的 Tunnel ID
credentials-file: /home/user/.cloudflared/xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx.json

ingress:
  - service: http://moltbot:18789
```

> ⚠️ **重要**: 不要在 Cloudflare Dashboard 中给 Tunnel 配置 Public Hostname！
> 这样 Tunnel 只能通过 Worker 内部访问，无公网入口。

---

## Step 2: 配置 Cloudflare Access

### 2.1 启用 Zero Trust

访问 [Cloudflare Zero Trust Dashboard](https://one.dash.cloudflare.com/)

### 2.2 创建 Access Application

1. 进入 **Access → Applications**
2. 点击 **Add an application**
3. 选择 **Self-hosted**
4. 填写配置:

| 字段 | 值 |
|------|---|
| Application name | Moltbot |
| Application domain | `moltbot-selfhosted.<你的用户名>.workers.dev` |
| Session duration | 24 hours (推荐) |

### 2.3 配置访问策略

在 Policies 页面:

1. Policy name: `Allow Team`
2. Action: `Allow`
3. Include rules:
   - **Emails ending in**: `@yourdomain.com` (或)
   - **Login Methods**: Google, GitHub 等

### 2.4 记录关键信息

在 Application 详情页获取:

| 信息 | 用途 |
|------|-----|
| **Team Domain** | 如 `myteam.cloudflareaccess.com` |
| **Application Audience (AUD) Tag** | 用于 Worker 验证 JWT |

---

## Step 3: 部署 Docker 服务

### 3.1 传输文件到服务器

```bash
# 在本地执行
scp -r selfhosted/ user@your-server:~/moltbot/
```

### 3.2 配置环境变量

```bash
# 在服务器执行
cd ~/moltbot/selfhosted
cp .env.example .env
nano .env
```

编辑 `.env` 文件:

```bash
# =============================================================================
# AI Provider Configuration (必填，选择其一)
# =============================================================================

# 方式 1: 直接使用 Anthropic API
ANTHROPIC_API_KEY=sk-ant-api03-xxxxxxxxxxxxx

# 方式 2: 使用 Cloudflare AI Gateway (可选)
# AI_GATEWAY_API_KEY=sk-ant-xxx
# AI_GATEWAY_BASE_URL=https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/anthropic

# =============================================================================
# Gateway Configuration (必填)
# =============================================================================

# 生成随机 Token: openssl rand -hex 32
MOLTBOT_GATEWAY_TOKEN=your-random-token-here

# 开发模式 (跳过设备配对)
DEV_MODE=false

# =============================================================================
# Cloudflare Tunnel (必填)
# =============================================================================

# Step 1.4 获取的 Tunnel Token
CLOUDFLARE_TUNNEL_TOKEN=eyJhIjoiYWJjZGVmLi4uIn0=

# =============================================================================
# Chrome Browser (可选)
# =============================================================================

# 保护 Chrome 访问的 Token
# CHROME_TOKEN=your-chrome-token

# =============================================================================
# Chat Channels (可选)
# =============================================================================

# Telegram
# TELEGRAM_BOT_TOKEN=your-bot-token
# TELEGRAM_DM_POLICY=pairing

# Discord
# DISCORD_BOT_TOKEN=your-bot-token
# DISCORD_DM_POLICY=pairing
```

### 3.3 启动服务

```bash
# 构建并启动
docker-compose up -d

# 查看状态
docker-compose ps

# 查看日志
docker-compose logs -f
```

预期输出:
```
moltbot-gateway   | [Gateway] Starting on port 18789
moltbot-chrome    | Chrome browser ready
moltbot-tunnel    | Connection established
```

---

## Step 4: 部署 Cloudflare Worker

### 4.1 构建项目

```bash
# 在本地项目目录
cd moltworker
npm install
npm run build
```

### 4.2 部署 Worker

```bash
# 登录 Wrangler
npx wrangler login

# 部署
npx wrangler deploy --config wrangler.selfhosted.jsonc
```

### 4.3 配置 Secrets

```bash
# Tunnel 内部地址 (用 Step 1.4 的 Tunnel ID)
npx wrangler secret put SELFHOSTED_URL --config wrangler.selfhosted.jsonc
# 输入: https://xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx.cfargotunnel.com

# Gateway Token (与 .env 中相同)
npx wrangler secret put MOLTBOT_GATEWAY_TOKEN --config wrangler.selfhosted.jsonc
# 输入: your-random-token-here

# Access Team Domain
npx wrangler secret put CF_ACCESS_TEAM_DOMAIN --config wrangler.selfhosted.jsonc
# 输入: myteam.cloudflareaccess.com

# Access AUD Tag
npx wrangler secret put CF_ACCESS_AUD --config wrangler.selfhosted.jsonc
# 输入: Step 2.4 获取的 AUD Tag
```

### 4.4 验证 Secrets

```bash
npx wrangler secret list --config wrangler.selfhosted.jsonc
```

应显示:
```
┌────────────────────────┬──────────┐
│ Name                   │ Type     │
├────────────────────────┼──────────┤
│ SELFHOSTED_URL         │ secret   │
│ MOLTBOT_GATEWAY_TOKEN  │ secret   │
│ CF_ACCESS_TEAM_DOMAIN  │ secret   │
│ CF_ACCESS_AUD          │ secret   │
└────────────────────────┴──────────┘
```

---

## Step 5: 验证部署

### 5.1 测试 Worker

访问你的 Worker URL:
```
https://moltbot-selfhosted.<你的用户名>.workers.dev
```

应该:
1. 被重定向到 Cloudflare Access 登录页面
2. 登录后看到 Moltbot 界面

### 5.2 测试健康检查

```bash
# 在服务器上测试 (内部)
docker exec moltbot-gateway curl -s http://localhost:18789/health

# 应返回
{"status":"ok","mode":"selfhosted"}
```

### 5.3 检查 Tunnel 连接

```bash
docker logs moltbot-tunnel
```

应显示:
```
INF Connection established
INF Registered tunnel connection
```

---

## 运维命令

### 日常操作

```bash
# 查看日志
docker-compose logs -f moltbot      # Moltbot 日志
docker-compose logs -f chrome       # Chrome 日志
docker-compose logs -f cloudflared  # Tunnel 日志

# 重启服务
docker-compose restart moltbot

# 停止所有服务
docker-compose down

# 启动服务
docker-compose up -d

# 重新构建并启动
docker-compose up -d --build
```

### 数据备份

```bash
# 备份配置和数据
docker run --rm \
  -v moltbot-config:/config \
  -v moltbot-workspace:/workspace \
  -v $(pwd):/backup \
  alpine tar czf /backup/moltbot-backup-$(date +%Y%m%d).tar.gz \
    /config /workspace

# 恢复备份
docker run --rm \
  -v moltbot-config:/config \
  -v moltbot-workspace:/workspace \
  -v $(pwd):/backup \
  alpine tar xzf /backup/moltbot-backup-YYYYMMDD.tar.gz
```

### 更新部署

```bash
# 服务器端: 更新 Docker 镜像
cd ~/moltbot/selfhosted
docker-compose pull
docker-compose up -d --build

# 本地: 更新 Worker
npm run build
npx wrangler deploy --config wrangler.selfhosted.jsonc
```

---

## 故障排查

### 问题: Worker 返回 503

**症状**: 访问 Worker 显示 "Self-hosted Moltbot gateway is not responding"

**检查**:
1. Tunnel 是否正常连接
   ```bash
   docker logs moltbot-tunnel
   ```
2. Moltbot 是否健康
   ```bash
   docker exec moltbot-gateway curl -s http://localhost:18789/health
   ```
3. SELFHOSTED_URL 是否正确配置

### 问题: Access 登录失败

**症状**: 登录后提示未授权

**检查**:
1. CF_ACCESS_AUD 是否正确
2. Access Policy 是否包含你的邮箱
3. Team Domain 是否正确

### 问题: WebSocket 连接失败

**症状**: 聊天界面无法连接

**检查**:
```bash
# 测试 WebSocket
docker exec moltbot-gateway curl -s http://localhost:18789/api/ws
```

### 问题: Chrome 启动失败

**症状**: CDP 相关功能无法使用

**检查**:
```bash
# 检查 Chrome 日志
docker logs moltbot-chrome

# 检查共享内存
docker inspect moltbot-chrome | grep ShmSize
# 应该是 2GB 或更多
```

---

## 配置参考

### 端口说明

| 服务 | 容器端口 | 说明 |
|------|---------|-----|
| moltbot | 18789 | AI Gateway API |
| chrome | 3000 | Chrome DevTools Protocol |

> 所有端口仅在 Docker 内部网络可访问，不暴露到公网。

### 环境变量速查

| 变量 | 必填 | 说明 |
|------|-----|-----|
| ANTHROPIC_API_KEY | ✅ | Anthropic API 密钥 |
| MOLTBOT_GATEWAY_TOKEN | ✅ | Gateway 访问 Token |
| CLOUDFLARE_TUNNEL_TOKEN | ✅ | Tunnel 连接 Token |
| DEV_MODE | ❌ | 开发模式 (默认 false) |
| CHROME_TOKEN | ❌ | Chrome 访问保护 |

### Worker Secrets 速查

| Secret | 说明 |
|--------|-----|
| SELFHOSTED_URL | `https://<tunnel-id>.cfargotunnel.com` |
| MOLTBOT_GATEWAY_TOKEN | 与 .env 中相同 |
| CF_ACCESS_TEAM_DOMAIN | Access 团队域名 |
| CF_ACCESS_AUD | Access 应用 AUD Tag |
