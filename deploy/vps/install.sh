#!/usr/bin/env bash
# Installs or updates the WhatsApp support database + dashboard on the shared
# VPS. Safe to run again: existing secrets, data and staff are kept.
#   cd /opt/ids-whatsapp && sudo bash deploy/vps/install.sh
# It touches only its own things:
#   - the Docker project "ids-wa";
#   - /opt/ids-whatsapp/.env and .compose.env;
#   - the nginx site support.wamsg.site.
# Other containers, the host PostgreSQL, n8n and other nginx sites are left
# alone. Secrets are generated here and never printed, except in
# n8n-credentials.txt (mode 600), which you type into n8n yourself.
set -euo pipefail

DOMAIN=support.wamsg.site
N8N_WEBHOOK_BASE=https://n8n.wamsg.site/webhook
N8N_NETWORK=n8n_default
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

say() { printf '\n== %s\n' "$*"; }
rand() { openssl rand -hex "${1:-32}"; }
compose() { docker compose -p ids-wa --env-file .compose.env -f docker-compose.yml -f deploy/vps/docker-compose.vps.yml "$@"; }

[ "$(id -u)" = 0 ] || { echo "Run as root (sudo)."; exit 1; }
docker network inspect "$N8N_NETWORK" >/dev/null 2>&1 || { echo "Docker network $N8N_NETWORK (n8n) not found."; exit 1; }

say "Secrets"
umask 077
if [ ! -f .compose.env ]; then
  echo "POSTGRES_SUPERUSER_PASSWORD=$(rand)" > .compose.env
  echo "created .compose.env"
fi
# Local port for the dashboard: chosen once, from those not in use on this host.
if ! grep -q '^IDS_APP_PORT=' .compose.env; then
  for p in $(seq 3110 3199); do
    ss -ltnH "( sport = :$p )" | grep -q . || { echo "IDS_APP_PORT=$p" >> .compose.env; break; }
  done
fi
APP_PORT=$(sed -n 's/^IDS_APP_PORT=//p' .compose.env)
[ -n "$APP_PORT" ] || { echo "No free port found in 3110-3199."; exit 1; }
echo "dashboard port: 127.0.0.1:${APP_PORT}"
if [ ! -f .env ]; then
  APP_PW=$(rand 24); N8N_PW=$(rand 24)
  cat > .env <<EOF
DATABASE_URL=postgresql://wa_app:${APP_PW}@db:5432/wa_support
DB_POOL_MAX=10
APP_ORIGIN=https://${DOMAIN}
COOKIE_SECURE=true
SESSION_TTL_HOURS=12
ZERNIO_WEBHOOK_SECRET=$(rand)
WOO_WEBHOOK_SECRET=$(rand)
N8N_WEBHOOK_BASE=${N8N_WEBHOOK_BASE}
N8N_INTERNAL_TOKEN=$(rand)
BACKEND_INTERNAL_TOKEN=$(rand)
OPENROUTER_API_KEY=
SHOP_NAME="Infinity Digital Shop"
WOO_BASE_URL=https://infinitydigitalshop.com
# Password of the wa_n8n role (goes into the n8n credential "IDS Postgres (wa_n8n)").
WA_N8N_DB_PASSWORD=${N8N_PW}
EOF
  echo "created .env"
fi
chmod 600 .env .compose.env
set -a; . ./.env; set +a
APP_PW=$(printf '%s' "$DATABASE_URL" | sed -E 's#^postgresql://wa_app:([^@]+)@.*#\1#')

say "Database"
compose up -d db
for i in $(seq 1 60); do
  compose exec -T db pg_isready -U postgres >/dev/null 2>&1 && break
  sleep 2
done
compose exec -T db pg_isready -U postgres >/dev/null
if [ "$(compose exec -T db psql -U postgres -tAc "SELECT 1 FROM pg_roles WHERE rolname='wa_app'")" != "1" ]; then
  compose exec -T db psql -U postgres -v ON_ERROR_STOP=1 -v app_pw="'${APP_PW}'" -v n8n_pw="'${WA_N8N_DB_PASSWORD}'" < db/roles.sql
  echo "roles and database created"
else
  echo "roles already exist"
fi

say "Build, migrate (also applies db/grants.sql), seed"
compose build app
compose run --rm -T app node scripts/migrate.mjs
compose run --rm -T app node scripts/seed.mjs

say "Owner account"
STAFF=$(compose exec -T db psql -U postgres -d wa_support -tAc "SELECT count(*) FROM app.staff_users")
if [ "${STAFF// /}" = "0" ]; then
  read -r -p "Owner email for the dashboard login: " OWNER_EMAIL
  read -r -p "Owner name: " OWNER_NAME
  while :; do
    read -r -s -p "Owner password (12+ characters, not shown): " OWNER_PW; echo
    read -r -s -p "Repeat password: " OWNER_PW2; echo
    [ "$OWNER_PW" = "$OWNER_PW2" ] && [ ${#OWNER_PW} -ge 12 ] && break
    echo "Passwords differ or are shorter than 12 characters. Try again."
  done
  STAFF_PASSWORD="$OWNER_PW" compose run --rm -T -e STAFF_PASSWORD app node scripts/create-staff.mjs --email "$OWNER_EMAIL" --name "$OWNER_NAME" --role owner
  unset OWNER_PW OWNER_PW2
else
  echo "staff accounts already exist (${STAFF// /}); none created"
fi

say "Dashboard"
compose up -d app
for i in $(seq 1 30); do
  curl -fsS "http://127.0.0.1:${APP_PORT}/api/health" >/dev/null 2>&1 && break
  sleep 2
done
curl -fsS "http://127.0.0.1:${APP_PORT}/api/health" && echo

say "nginx + HTTPS for ${DOMAIN}"
# Debian-style nginx uses sites-available/sites-enabled; nginx.org packages use conf.d.
if [ -d /etc/nginx/sites-available ] && grep -q 'sites-enabled' /etc/nginx/nginx.conf; then
  SITE=/etc/nginx/sites-available/${DOMAIN}; LINK=/etc/nginx/sites-enabled/${DOMAIN}
else
  SITE=/etc/nginx/conf.d/${DOMAIN}.conf; LINK=
fi
if grep -rqs "server_name[^;]*\b${DOMAIN}\b" /etc/nginx/ --include='*' && [ ! -f "$SITE" ]; then
  echo "Another nginx file already serves ${DOMAIN}:"; grep -rls "server_name[^;]*\b${DOMAIN}\b" /etc/nginx/
  echo "Not changing nginx. Remove or rename that server block, then run this script again."; exit 1
fi
if [ ! -f "$SITE" ]; then
  sed "s/__APP_PORT__/${APP_PORT}/" deploy/vps/nginx-support.conf > "$SITE"
  [ -n "$LINK" ] && ln -sf "$SITE" "$LINK"
  if ! nginx -t; then rm -f "$SITE" ${LINK:+"$LINK"}; echo "nginx rejected the new site; removed it again."; exit 1; fi
  systemctl reload nginx
  command -v certbot >/dev/null || apt-get install -y certbot python3-certbot-nginx
  certbot --nginx -d "$DOMAIN" --redirect
  # The other sites here listen on 75.119.130.7:443; nginx prefers IP-bound
  # listeners, so a plain "listen 443" block would never be chosen.
  sed -i -E 's/^(\s*)listen 443 ssl;/\1listen 75.119.130.7:443 ssl;/; s/^(\s*)listen 80;/\1listen 75.119.130.7:80;/' "$SITE"
  nginx -t && systemctl reload nginx
else
  echo "nginx site already present: $SITE (not changed)"
fi
curl -fsS "https://${DOMAIN}/api/health" && echo

say "Values for the last three n8n credentials"
cat > n8n-credentials.txt <<EOF
Type these into n8n (Credentials -> Add credential). Do not paste them into chat.

1) IDS Postgres (wa_n8n)      type: Postgres
   Host: ids-wa-db   Database: wa_support   User: wa_n8n   Port: 5432   SSL: disable
   Password: ${WA_N8N_DB_PASSWORD}

2) IDS Inbound Token (backend to n8n)      type: Header Auth
   Name: Authorization
   Value: Bearer ${N8N_INTERNAL_TOKEN}

3) IDS Backend Token (n8n to backend)      type: Header Auth
   Name: X-Internal-Token
   Value: ${BACKEND_INTERNAL_TOKEN}

Later, for the Zernio webhook (https://${DOMAIN}/api/webhooks/zernio), secret:
   ${ZERNIO_WEBHOOK_SECRET}
EOF
chmod 600 n8n-credentials.txt
echo "Written to ${ROOT}/n8n-credentials.txt (show it with: cat ${ROOT}/n8n-credentials.txt)"

say "Done"
echo "Dashboard: https://${DOMAIN}"
compose ps
