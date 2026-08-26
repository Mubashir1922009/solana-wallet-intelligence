#!/usr/bin/env bash
# Solana Wallet Intelligence - Oracle Cloud Always Free VM setup
# Run ONCE on a fresh Ubuntu 22.04+ ARM (aarch64) VM as a sudo-capable user.
# Usage: SWI_GITHUB_TOKEN=github_pat_xxx sudo -E bash oracle-vm-setup.sh
set -euo pipefail

if [[ "$(uname -m)" != "aarch64" ]]; then echo "WARNING: expected ARM (aarch64) for Always Free shape"; fi
if [[ -z "${SWI_GITHUB_TOKEN:-}" ]]; then echo "ERROR: set SWI_GITHUB_TOKEN (fine-grained PAT, Contents:read on the repo)"; exit 1; fi

echo "[1/7] system packages"
sudo apt-get update -qq
sudo apt-get install -y -qq git curl ca-certificates

echo "[2/7] Node.js 22"
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y -qq nodejs
fi
node --version

echo "[3/7] clone repository"
sudo mkdir -p /opt/swi && sudo chown "$USER":"$USER" /opt/swi
if [[ ! -d /opt/swi/repo ]]; then
  git clone "https://${SWI_GITHUB_TOKEN}@github.com/Mubashir1922009/solana-wallet-intelligence.git" /opt/swi/repo
else
  cd /opt/swi/repo && git pull
fi
cd /opt/swi/repo

echo "[4/7] install dependencies + build worker"
sudo chown -R "$USER":"$USER" /opt/swi/repo
corepack enable
corepack pnpm@10.15.1 install --frozen-lockfile
corepack pnpm@10.15.1 --filter @intelligence/worker build

echo "[5/7] environment file (fill values, chmod 600)"
sudo tee /etc/swi.env >/dev/null <<'ENV'
NODE_ENV=production
EXECUTION_MODE=SHADOW
MAX_LIVE_SUBSCRIPTIONS=25
TOKEN_DISCOVERY_INTERVAL_MS=120000
DATABASE_URL=paste-staging-postgres-url
HELIUS_API_KEY=paste-helius-key
OPENROUTER_API_KEY=paste-openrouter-key
GROQ_API_KEY=paste-groq-key
SESSION_SECRET=paste-generated-session-secret
OPERATOR_PASSWORD_HASH=paste-scrypt-hash
CORS_ALLOWED_ORIGIN=https://placeholder.local
SOLANA_RPC_URL=https://mainnet.helius-rpc.com
SOLANA_WS_URL=wss://mainnet.helius-rpc.com
ENV
# RPC/WS URLs get the real api-key appended at runtime by the service below if left templated
sudo chmod 600 /etc/swi.env

echo "[6/7] systemd service (auto-start on boot, auto-restart on crash)"
sudo tee /etc/systemd/system/swi-worker.service >/dev/null <<'UNIT'
[Unit]
Description=Solana Wallet Intelligence continuous SHADOW worker
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/opt/swi/repo
EnvironmentFile=/etc/swi.env
ExecStart=/usr/bin/corepack pnpm@10.15.1 exec tsx apps/worker/src/main.ts
Restart=always
RestartSec=10
MemoryMax=1G

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable --now swi-worker

echo "[7/7] verify"
sleep 8
sudo systemctl is-active swi-worker && echo "WORKER IS LIVE ON THE VM - 24/7, laptop-independent, \$0/month"
sudo journalctl -u swi-worker -n 10 --no-pager
