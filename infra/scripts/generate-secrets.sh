#!/usr/bin/env sh
# Generates secrets into infra/.env (only empty values are filled) and the generated/ config files:
#   generated/template-kek.b64  key-encryption key for biometric templates (keep a copy OFFLINE; never in DB backups)
#   generated/s3.json           SeaweedFS S3 identity
#   generated/mosquitto.conf    broker config (TLS 8883 + dynamic security)
set -eu
cd "$(dirname "$0")/.."
if [ ! -f .env ]; then
  if [ -f .env.example ]; then
    cp .env.example .env
  else
    # .env files are not kept in the repository; write the template here.
    cat > .env <<'EOF'
# Public DNS name of the platform (A record -> this server). Used for HTTPS, device API and MQTT/TLS.
BAMP_DOMAIN=
# Email for Let's Encrypt expiry notices
LETSENCRYPT_EMAIL=

# Generated below; do not commit real values.
POSTGRES_PASSWORD=
REDIS_PASSWORD=
MQTT_CLOUD_PASSWORD=
S3_ACCESS_KEY=
S3_SECRET_KEY=

# Outbound email (invitations, password reset, alert notifications)
SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASSWORD=
SMTP_FROM=

# Optional error-tracking webhook
ERROR_WEBHOOK_URL=

# Only with --profile reference-websoft
WEBSOFT_API_KEY=
WEBSOFT_ADMIN_EMAIL=
WEBSOFT_ADMIN_PASSWORD=
EOF
    echo "Created infra/.env — set BAMP_DOMAIN and LETSENCRYPT_EMAIL before continuing."
  fi
fi
mkdir -p generated

rand() { head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c "${1:-32}"; }
setvar() {
  key="$1"; val="$2"
  if grep -q "^${key}=$" .env; then
    sed -i.bak "s|^${key}=$|${key}=${val}|" .env && rm -f .env.bak
  fi
}
setvar POSTGRES_PASSWORD "$(rand 32)"
setvar REDIS_PASSWORD "$(rand 32)"
setvar MQTT_CLOUD_PASSWORD "$(rand 32)"
setvar S3_ACCESS_KEY "BAMP$(rand 16 | tr 'a-z' 'A-Z')"
setvar S3_SECRET_KEY "$(rand 40)"
setvar WEBSOFT_API_KEY "wsk_$(rand 40)"
setvar WEBSOFT_ADMIN_PASSWORD "$(rand 16)"

# shellcheck disable=SC1091
. ./.env

if [ ! -f generated/template-kek.b64 ]; then
  head -c 32 /dev/urandom | base64 > generated/template-kek.b64
  chmod 600 generated/template-kek.b64
  echo "Generated template KEK → infra/generated/template-kek.b64 (store an offline copy in your key vault)"
fi

cat > generated/s3.json <<EOF
{"identities":[{"name":"bamp-backend","credentials":[{"accessKey":"${S3_ACCESS_KEY}","secretKey":"${S3_SECRET_KEY}"}],"actions":["Admin","Read","Write","List","Tagging"]}]}
EOF
chmod 600 generated/s3.json

cat > generated/mosquitto.conf <<EOF
allow_anonymous false
persistence true
persistence_location /mosquitto/data/
plugin /usr/lib/mosquitto_dynamic_security.so
plugin_opt_config_file /mosquitto/data/dynamic-security.json

# MQTT over TLS only (NFR-1.2); certificate issued by Let's Encrypt for ${BAMP_DOMAIN}
listener 8883
certfile /etc/letsencrypt/live/${BAMP_DOMAIN}/fullchain.pem
keyfile /etc/letsencrypt/live/${BAMP_DOMAIN}/privkey.pem
tls_version tlsv1.2
max_keepalive 120
EOF
echo "Secrets and generated configs ready. Next: ./scripts/init-letsencrypt.sh"
