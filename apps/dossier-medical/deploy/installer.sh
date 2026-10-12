#!/usr/bin/env bash
# Installe (ou met à jour) l'appli « Dossier médical » sur un serveur Ubuntu (ex : VPS Oracle Cloud).
#
# Usage :   sudo bash installer.sh mon-domaine.fr mon-email@exemple.fr
# Relancer la même commande plus tard met l'appli à jour avec la dernière version du dépôt.
#
# Le serveur ne fait que distribuer les fichiers de l'appli : aucune donnée médicale n'y est stockée
# (les documents restent chiffrés dans Google Drive, les RDV dans Google Agenda).
set -euo pipefail

DOMAINE="${1:-}"
EMAIL="${2:-}"
BRANCHE="${BRANCHE:-main}"
DEPOT="https://github.com/maxencedevos83/Suivi-Hydratation.git"
SOURCES="/opt/suivi-hydratation"
SITE="/var/www/dossier-medical"
CONF="/etc/nginx/sites-available/dossier-medical"

if [ -z "$DOMAINE" ] || [ -z "$EMAIL" ]; then
  echo "Usage : sudo bash installer.sh mon-domaine.fr mon-email@exemple.fr"
  exit 1
fi
if [ "$(id -u)" -ne 0 ]; then
  echo "Lance ce script avec sudo : sudo bash installer.sh $DOMAINE $EMAIL"
  exit 1
fi

echo "==> 1/5 Installation de nginx, certbot et git"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q nginx certbot python3-certbot-nginx git rsync

echo "==> 2/5 Ouverture des ports 80 et 443 dans le pare-feu du serveur"
# Les images Ubuntu d'Oracle Cloud bloquent tout sauf SSH avec une règle REJECT dans iptables
for PORT in 80 443; do
  if ! iptables -C INPUT -p tcp -m state --state NEW --dport "$PORT" -j ACCEPT 2>/dev/null; then
    POS=$(iptables -L INPUT --line-numbers -n | awk '$2 == "REJECT" { print $1; exit }')
    if [ -n "$POS" ]; then
      iptables -I INPUT "$POS" -p tcp -m state --state NEW --dport "$PORT" -j ACCEPT
    else
      iptables -A INPUT -p tcp -m state --state NEW --dport "$PORT" -j ACCEPT
    fi
  fi
done
if command -v netfilter-persistent >/dev/null 2>&1; then netfilter-persistent save >/dev/null; fi
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then ufw allow 'Nginx Full' >/dev/null; fi

echo "==> 3/5 Récupération de l'appli (branche $BRANCHE)"
if [ -d "$SOURCES/.git" ]; then
  git -C "$SOURCES" fetch -q --depth 1 origin "$BRANCHE"
  git -C "$SOURCES" reset -q --hard FETCH_HEAD
else
  rm -rf "$SOURCES"
  git clone -q --depth 1 --branch "$BRANCHE" "$DEPOT" "$SOURCES"
fi
mkdir -p "$SITE"
rsync -a --delete --exclude deploy --exclude README.md "$SOURCES/apps/dossier-medical/" "$SITE/"
chown -R www-data:www-data "$SITE"

echo "==> 4/5 Configuration de nginx"
# Écrite seulement à la première installation : certbot la complète ensuite pour HTTPS
if [ ! -f "$CONF" ]; then
  cat > "$CONF" <<NGINX
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAINE;

    root $SITE;
    index index.html;

    add_header X-Content-Type-Options nosniff always;
    add_header Referrer-Policy no-referrer always;
    add_header X-Frame-Options DENY always;

    location / {
        try_files \$uri \$uri/ =404;
    }

    # Page et service worker : toujours la dernière version
    location ~ ^/(index\.html|ws\.js|manifest\.json)?\$ {
        add_header Cache-Control "no-cache" always;
        add_header X-Content-Type-Options nosniff always;
        add_header Referrer-Policy no-referrer always;
        add_header X-Frame-Options DENY always;
        try_files \$uri /index.html;
    }
}
NGINX
  ln -sf "$CONF" /etc/nginx/sites-enabled/dossier-medical
  rm -f /etc/nginx/sites-enabled/default
fi
nginx -t
systemctl enable --now nginx >/dev/null
systemctl reload nginx

echo "==> 5/5 Certificat HTTPS (Let's Encrypt)"
if [ -d "/etc/letsencrypt/live/$DOMAINE" ]; then
  echo "Certificat déjà en place (renouvelé automatiquement)."
else
  IP_SERVEUR=$(curl -fsS --max-time 5 https://api.ipify.org || true)
  IP_DOMAINE=$(getent ahostsv4 "$DOMAINE" | awk '{ print $1; exit }' || true)
  if [ -n "$IP_SERVEUR" ] && [ "$IP_SERVEUR" != "$IP_DOMAINE" ]; then
    echo "⚠️  $DOMAINE pointe vers « ${IP_DOMAINE:-rien} » alors que ce serveur est $IP_SERVEUR."
    echo "    Corrige l'enregistrement DNS (type A), attends quelques minutes, puis relance ce script."
    exit 1
  fi
  certbot --nginx -n --agree-tos --redirect -m "$EMAIL" -d "$DOMAINE"
fi

echo
echo "✅ L'appli est en ligne : https://$DOMAINE/"
