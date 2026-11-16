#!/usr/bin/env bash
# Deploy Saltline Arena to a Linux host (static site + WebSocket game server).
#   deploy/deploy.sh root@your.host
# First time on a new host: copy deploy/saltline-arena.service to /etc/systemd/system/, adapt
# deploy/nginx-saltline.conf (server_name, certificate paths) into the nginx conf.d directory,
# then `systemctl enable --now saltline-arena`. Needs Node 20.19+ on the host.
# WebRTC (UDP poses): open the UDP port RTC_PORT in the firewall / cloud security group and set
# RTC_PUBLIC_IP in the service unit to the address players reach (needed behind NAT).
set -euo pipefail
HOST="${1:?usage: deploy/deploy.sh user@host}"
cd "$(dirname "$0")/.."
npm run build
ssh "$HOST" 'mkdir -p /opt/saltline-arena/src/versus /opt/saltline-arena/src/brawl /var/www/saltline'
rsync -az --delete server/ "$HOST:/opt/saltline-arena/server/"
rsync -az src/versus/rules.js "$HOST:/opt/saltline-arena/src/versus/"
rsync -az src/brawl/rules.js "$HOST:/opt/saltline-arena/src/brawl/"
rsync -az package.json "$HOST:/opt/saltline-arena/"
rsync -az --delete dist/standalone/ "$HOST:/var/www/saltline/"
# WebRTC data channel (optional native module; the server runs without it, WebSocket only)
ssh "$HOST" 'cd /opt/saltline-arena && PATH=/opt/node/bin:$PATH npm install --omit=dev --no-audit --no-fund --loglevel=error || echo "npm install failed: no WebRTC, WebSocket only"'
ssh "$HOST" 'chmod -R a+rX /var/www/saltline /opt/saltline-arena && systemctl restart saltline-arena && systemctl is-active saltline-arena'
