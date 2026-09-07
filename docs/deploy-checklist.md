# MOI MCP — deployment checklist

Steps to deploy the MCP gateway and verify it end to end. Background and
reasoning: `docs/deploy-vm.md`.

## Before starting, have

- Ubuntu VM with Node.js 20+ and nginx
- A **dedicated hostname** with DNS pointing at the VM and a TLS certificate.
  No redirects on this hostname, not even HTTP→HTTPS (a redirect drops the
  `Authorization` header and sign-in silently breaks).
- A WalletConnect project id — free at https://cloud.reown.com
- A phone with MOI Wallet installed (for the final check)

## 1. Install

```bash
sudo mkdir -p /opt/moi-mcp && sudo chown "$USER" /opt/moi-mcp
git clone https://github.com/sarvalabs-adithya/moi-mcp.git /opt/moi-mcp
cd /opt/moi-mcp
npm ci
npm run build
sudo npm install -g pm2
```

## 2. Configure

```bash
cd /opt/moi-mcp
printf 'WC_PROJECT_ID=your_32_character_id_here\n' > .env
chmod 600 .env

sudo mkdir -p /var/lib/moi-mcp && sudo chown "$USER" /var/lib/moi-mcp
chmod 700 /var/lib/moi-mcp
```

Edit `ecosystem.config.cjs`: set `PUBLIC_URL` to the real hostname
(`https://your.hostname`). It must match exactly what users reach or sign-in
fails.

## 3. Start

```bash
pm2 start ecosystem.config.cjs --only moi-mcp-write
pm2 save
pm2 startup   # prints a sudo command — run it

curl localhost:8788/health
# {"ok":true,"network":"voyage","readOnly":false,"pairingMounted":true}
```

## 4. nginx

```nginx
limit_req_zone $binary_remote_addr zone=moimcp:10m rate=10r/s;

server {
    listen 443 ssl http2;
    server_name your.hostname;

    # your certificate directives

    location / {
        limit_req zone=moimcp burst=20 nodelay;

        proxy_pass http://127.0.0.1:8788;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_buffering off;      # required — responses stream
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
        gzip off;
    }
}
```

```bash
sudo nginx -t && sudo systemctl reload nginx
```

## 5. Verify from outside

```bash
curl https://your.hostname/health

curl -X POST https://your.hostname/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
# should list 13 tools
```

## 6. Connect in Claude

claude.ai → Settings → Connectors → Add custom connector → paste
`https://your.hostname/mcp` → authentication: **OAuth** (not None).

## 7. Verify end to end

In a Claude chat, in order:

1. Ask: *"what's the supply of asset 0x1080... on voyage"* — a read should
   return real chain data.
2. Ask: *"connect my MOI wallet"* — sign in when prompted, a QR appears in
   the chat, scan it with MOI Wallet on the phone.
3. Ask: *"create a test asset called DEPLOYTEST with supply 100"* — an
   approval prompt appears on the phone; approve it.
4. Ask: *"what's my wallet status"* — should show the paired account.

Deployment is done when step 3 lands on chain.

## Optional: separate read-only gateway

A stateless, no-secrets endpoint (6 tools) safe to share publicly. Needs its
own dedicated hostname.

```bash
pm2 start ecosystem.config.cjs --only moi-mcp-read && pm2 save
curl localhost:8787/health
```

Same nginx block on the other hostname with `proxy_pass http://127.0.0.1:8787`.
In Claude, add it with authentication **None**.

## Updating

```bash
cd /opt/moi-mcp && git pull && npm ci && npm run build
pm2 restart moi-mcp-write   # restart, NOT reload
```
