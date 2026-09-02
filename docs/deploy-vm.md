# Hosting `moi-mcp-http` on a VM

This covers the **read-only** HTTP transport only — 6 tools, no wallet, no
`WC_PROJECT_ID`, stateless. The stdio server (writes, wallet) stays local; see
`docs/local-testing.md`. Do not adapt this runbook to run the stdio server —
it isn't stateless and was never designed to sit behind a load balancer.

## Prerequisites

- An existing Ubuntu VM with **Node.js 20+** (`node -v`) and **nginx**, TLS
  already terminating there (this doc doesn't cover certificates).
- A **dedicated hostname** for this service — placeholder `mcp.moi.technology`
  below. Use an exact host you control, not a path under an existing one.

> [!WARNING]
> **Do not reuse the Explorer API host**, and **do not add any redirect on
> this host** (HTTP→HTTPS or otherwise). A redirect drops the `Authorization`
> header on the follow-up request, and claude.ai will not retry with it
> restored — the connector will look "authenticated" and then silently 401 on
> every call. Terminate TLS directly on `mcp.moi.technology`; no hop through a
> host that redirects.

## 1. Install and run with pm2

```bash
sudo npm install -g pm2 @moi-protocol/mcp-server
```

```bash
MOI_NETWORK=voyage PORT=8787 pm2 start moi-mcp-http --name moi-mcp
pm2 save
pm2 startup   # prints a systemd command; run the one it prints, as root
```

`moi-mcp-http` needs no `WC_PROJECT_ID` — it registers no wallet tools, so
`MOI_NETWORK` is the only env var this needs. Confirm it's alive locally
before touching nginx:

```bash
curl -s localhost:8787/health
```

## 2. nginx reverse proxy

```nginx
# /etc/nginx/conf.d/moi-mcp.conf
limit_req_zone $binary_remote_addr zone=moi_mcp:10m rate=10r/s;

server {
    listen 443 ssl;
    server_name mcp.moi.technology;

    # ... your existing ssl_certificate / ssl_certificate_key directives ...

    location / {
        limit_req zone=moi_mcp burst=20 nodelay;

        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;

        # SSE dies if nginx buffers the response — it never flushes.
        proxy_buffering off;
        gzip off;

        # claude.ai's own tool-call budget is ~300s; match it so nginx
        # doesn't cut the connection first.
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
}
```

Reload once the config is in place:

```bash
sudo nginx -t && sudo systemctl reload nginx
```

## 3. Verify from the outside

```bash
curl -s https://mcp.moi.technology/health
# {"ok":true,...}

curl -s https://mcp.moi.technology/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
# a JSON-RPC result with serverInfo and capabilities
```

If `/health` works but `/mcp` doesn't, it's almost always the reverse proxy
(missing `Accept` header upstream, or something still buffering) rather than
the server — `curl -s localhost:8787/mcp ...` with the same body isolates it.

## 4. Add it in claude.ai

Settings → Connectors → **Add custom connector** → `https://mcp.moi.technology/mcp`,
authentication **None**.

> Custom connectors may require a paid claude.ai plan — if the option is
> missing, that's why.

## A note for the future write service

This VM hosts the read-only transport, which is stateless by design — any
number of instances behind a load balancer would be fine. The **write**
service (when it ships) will not be: it holds live WalletConnect sessions and
pending approvals in memory, so it is **single-instance only**.

```bash
pm2 start moi-mcp-http --name moi-mcp -i 1   # never -i max, never "cluster"
```

Scaling it horizontally would split sessions across processes that don't share
state, so a pairing done on one instance would be invisible to the others.
Don't cluster it; don't put it behind more than one node until that's been
redesigned.
