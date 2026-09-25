#!/usr/bin/env bash
# Carries SSH over HTTPS: wss://support.wamsg.site/_ops/ssh -> 127.0.0.1:22.
# Login still requires an authorized SSH key (~/.ssh/authorized_keys); this
# adds no password, token or new account. It is for maintenance sessions that
# can only reach the server over HTTPS.
#   bash deploy/vps/remote-access.sh on      # enable
#   bash deploy/vps/remote-access.sh off     # disable and remove
#   bash deploy/vps/remote-access.sh status
set -euo pipefail

SITE=/etc/nginx/conf.d/support.wamsg.site.conf
UNIT=/etc/systemd/system/ids-ssh-bridge.service
BRIDGE=/usr/local/lib/ids-ssh-bridge.py
MARK="# ids-ssh-bridge"
DIR="$(cd "$(dirname "$0")" && pwd)"
[ "$(id -u)" = 0 ] || { echo "Run as root."; exit 1; }
[ -f "$SITE" ] || { echo "$SITE not found (run install.sh first)."; exit 1; }

case "${1:-status}" in
  on)
    install -m 0755 "$DIR/ssh-ws-bridge.py" "$BRIDGE"
    cat > "$UNIT" <<EOF
[Unit]
Description=SSH over WebSocket bridge for support.wamsg.site/_ops/ssh
After=network.target ssh.service

[Service]
ExecStart=/usr/bin/python3 $BRIDGE
DynamicUser=yes
Restart=on-failure
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload
    systemctl enable --now ids-ssh-bridge
    if ! grep -q "$MARK" "$SITE"; then
      cp "$SITE" "$SITE.bak-ssh-bridge"
      # Insert before the first "location / {" (the HTTPS server block).
      awk -v mark="$MARK" '
        !done && /location \/ \{/ {
          print "    location = /_ops/ssh { " mark
          print "        proxy_pass http://127.0.0.1:8022; " mark
          print "        proxy_http_version 1.1; " mark
          print "        proxy_set_header Upgrade $http_upgrade; " mark
          print "        proxy_set_header Connection \"upgrade\"; " mark
          print "        proxy_read_timeout 1h; " mark
          print "        proxy_send_timeout 1h; " mark
          print "    } " mark
          done = 1
        }
        { print }' "$SITE.bak-ssh-bridge" > "$SITE"
      if ! nginx -t; then cp "$SITE.bak-ssh-bridge" "$SITE"; echo "nginx rejected the change; restored."; exit 1; fi
      systemctl reload nginx
    fi
    echo "enabled: wss://support.wamsg.site/_ops/ssh (SSH key login only)"
    ;;
  off)
    systemctl disable --now ids-ssh-bridge 2>/dev/null || true
    rm -f "$UNIT" "$BRIDGE"; systemctl daemon-reload
    if grep -q "$MARK" "$SITE"; then
      sed -i "/$MARK/d" "$SITE"
      nginx -t && systemctl reload nginx
    fi
    echo "disabled and removed"
    ;;
  status)
    systemctl is-active ids-ssh-bridge 2>/dev/null || true
    grep -c "$MARK" "$SITE" | sed 's/^/nginx lines: /'
    ;;
  *) echo "usage: $0 on|off|status"; exit 1 ;;
esac
