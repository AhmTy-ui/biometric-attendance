#!/usr/bin/env sh
# Obtains the first Let's Encrypt certificate for $BAMP_DOMAIN using a temporary HTTP-only nginx,
# then initialises the Mosquitto dynamic-security store with the cloud identity.
set -eu
cd "$(dirname "$0")/.."
# shellcheck disable=SC1091
. ./.env
: "${BAMP_DOMAIN:?set BAMP_DOMAIN in infra/.env}"
: "${LETSENCRYPT_EMAIL:?set LETSENCRYPT_EMAIL in infra/.env}"

echo "==> Requesting certificate for ${BAMP_DOMAIN}"
docker compose run --rm -d --name bamp-acme -p 80:80 --entrypoint "" nginx \
  sh -c 'mkdir -p /var/www/certbot && printf "server { listen 80; location /.well-known/acme-challenge/ { root /var/www/certbot; } }" > /etc/nginx/conf.d/default.conf && nginx -g "daemon off;"' >/dev/null
trap 'docker rm -f bamp-acme >/dev/null 2>&1 || true' EXIT
sleep 3
docker compose run --rm --entrypoint certbot certbot certonly --webroot -w /var/www/certbot \
  -d "${BAMP_DOMAIN}" --email "${LETSENCRYPT_EMAIL}" --agree-tos --no-eff-email --non-interactive
docker rm -f bamp-acme >/dev/null 2>&1 || true

echo "==> Initialising Mosquitto dynamic security"
docker compose run --rm --entrypoint "" mosquitto sh -c \
  "[ -f /mosquitto/data/dynamic-security.json ] || mosquitto_ctrl dynsec init /mosquitto/data/dynamic-security.json bamp-cloud '${MQTT_CLOUD_PASSWORD}' && chown -R mosquitto:mosquitto /mosquitto/data"

echo "Done. Start the stack with: docker compose up -d"
