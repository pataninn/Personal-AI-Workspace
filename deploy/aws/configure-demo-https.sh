#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly NGINX_SITE=/etc/nginx/conf.d/personal-ai-demo.conf
readonly WEBROOT=/var/lib/personal-ai/acme
readonly APP_CA=/etc/personal-ai-workspace/tls/app-ca.pem
readonly CERTBOT=/snap/bin/certbot
readonly PROD_CONFIG=/mnt/pai-data/letsencrypt
readonly PROD_WORK=/mnt/pai-data/acme-work
readonly PROD_LOGS=/mnt/pai-data/acme-logs
readonly STAGING_CONFIG=/mnt/pai-data/letsencrypt-staging
readonly STAGING_WORK=/mnt/pai-data/acme-staging-work
readonly STAGING_LOGS=/mnt/pai-data/acme-staging-logs
readonly LOCK_FILE=/run/lock/pai-configure-demo-https.lock
readonly MARKER='# Managed by configure-demo-https.sh; regenerate from the shipped template.'

WORK_DIR=
PROBE_TOKEN_PATH=
ISSUE_SWITCHED_CONFIG=0
ISSUE_TIMER_ENABLED=0
ISSUE_TIMER_STARTED=0
BOOTSTRAP_RENDERED=
FINAL_RENDERED=

usage() {
  cat >&2 <<'USAGE'
Usage:
  sudo bash configure-demo-https.sh prepare <EIP> --confirm-global-inference-paused --confirm-web-ingress-disabled
  sudo bash configure-demo-https.sh issue <EIP> --confirm-global-inference-paused --confirm-web-ingress-enabled [--non-interactive-no-email]

Without --non-interactive-no-email, issue needs a TTY for the operator's
Certbot terms and contact prompts. The explicit no-email mode accepts the CA
terms without contact details. This script never changes AWS security groups.
USAGE
  exit 2
}

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

rollback_issue_config() {
  if (( ISSUE_SWITCHED_CONFIG == 1 )) && [[ -f "$NGINX_SITE" && -f "$BOOTSTRAP_RENDERED" && -f "$FINAL_RENDERED" ]] && cmp -s -- "$NGINX_SITE" "$FINAL_RENDERED"; then
    if install -o root -g root -m 0644 -- "$BOOTSTRAP_RENDERED" "$NGINX_SITE" && /usr/sbin/nginx -t >/dev/null 2>&1 && /bin/systemctl reload nginx >/dev/null 2>&1; then
      printf 'HTTPS switch did not complete; restored the HTTP challenge-only bootstrap config.\n' >&2
    else
      printf 'WARNING: HTTPS switch failed and automatic config rollback also failed; inspect Nginx before opening browser traffic.\n' >&2
    fi
  fi
  if (( ISSUE_TIMER_STARTED == 1 )); then
    /bin/systemctl stop pai-cert-renew.timer >/dev/null 2>&1 || true
  fi
  if (( ISSUE_TIMER_ENABLED == 1 )); then
    /bin/systemctl disable pai-cert-renew.timer >/dev/null 2>&1 || true
  fi
}

cleanup() {
  local status=$?
  trap - EXIT
  if (( status != 0 )); then
    rollback_issue_config
  fi
  if [[ -n "$PROBE_TOKEN_PATH" ]]; then
    rm -f -- "$PROBE_TOKEN_PATH"
  fi
  if [[ -n "$WORK_DIR" && -d "$WORK_DIR" ]]; then
    rm -f -- "$WORK_DIR"/*
    rmdir -- "$WORK_DIR" 2>/dev/null || true
  fi
  exit "$status"
}
trap cleanup EXIT

[[ "$EUID" -eq 0 ]] || die 'Run as root through the already-authorized SSM session.'
[[ $# -ge 3 ]] || usage
PHASE=$1
PUBLIC_IP=$2
shift 2

case "$PHASE" in
  prepare)
    [[ $# -eq 2 ]] || usage
    seen_pause=0
    seen_ingress_disabled=0
    for argument in "$@"; do
      case "$argument" in
        --confirm-global-inference-paused) seen_pause=1 ;;
        --confirm-web-ingress-disabled) seen_ingress_disabled=1 ;;
        *) usage ;;
      esac
    done
    (( seen_pause == 1 && seen_ingress_disabled == 1 )) || usage
    ;;
  issue)
    [[ $# -eq 2 || $# -eq 3 ]] || usage
    seen_pause=0
    seen_ingress=0
    ISSUE_MODE=interactive
    for argument in "$@"; do
      case "$argument" in
        --confirm-global-inference-paused) seen_pause=1 ;;
        --confirm-web-ingress-enabled) seen_ingress=1 ;;
        --non-interactive-no-email) ISSUE_MODE=noninteractive_no_email ;;
        *) usage ;;
      esac
    done
    (( seen_pause == 1 && seen_ingress == 1 )) || usage
    if [[ "$ISSUE_MODE" == interactive ]]; then
      [[ -t 0 && -t 1 ]] || die 'Use an interactive SSM Session for CA prompts, or explicitly select --non-interactive-no-email.'
    fi
    ;;
  *) usage ;;
esac

python3 - "$PUBLIC_IP" <<'PY' || die 'The supplied address must be a globally routable IPv4 Elastic IP.'
import ipaddress
import sys

try:
    address = ipaddress.ip_address(sys.argv[1])
except ValueError:
    raise SystemExit(1)
if address.version != 4 or not address.is_global:
    raise SystemExit(1)
PY

for command in python3 install mountpoint curl openssl stat realpath flock ss od tr cmp find; do
  command -v "$command" >/dev/null 2>&1 || die "Required host utility is missing: $command."
done
[[ -x /usr/sbin/nginx && -x /bin/systemctl ]] || die 'Install the official Ubuntu Nginx package and systemd before running this script.'
[[ -x "$CERTBOT" ]] || die 'Install the official Certbot Snap at /snap/bin/certbot before running this script.'
[[ -f "$SCRIPT_DIR/nginx-demo-bootstrap.conf.example" && -f "$SCRIPT_DIR/nginx-demo.conf.example" && -f "$SCRIPT_DIR/pai-cert-renew.service" && -f "$SCRIPT_DIR/pai-cert-renew.timer" ]] || die 'Keep this script beside the two Nginx templates and two renewal unit files from deploy/aws.'

exec {lock_fd}>"$LOCK_FILE"
flock -n "$lock_fd" || die 'Another HTTPS configuration run is already active.'
WORK_DIR="$(mktemp -d /run/pai-configure-demo-https.XXXXXX)"

render_template() {
  local template=$1 destination=$2
  {
    printf '%s\n' "$MARKER"
    sed "s/REPLACE_WITH_PUBLIC_IP/$PUBLIC_IP/g" "$template"
  } >"$destination"
  if grep -Fq 'REPLACE_WITH_' "$destination"; then
    die 'A shipped Nginx template still contains an unreplaced value.'
  fi
}

assert_mounted_data() {
  mountpoint -q /mnt/pai-data || die '/mnt/pai-data is not a mounted retained data volume.'
}

ensure_private_dir() {
  local directory=$1
  if [[ -L "$directory" ]]; then
    die "Refusing a symlink at retained certificate path: $directory."
  fi
  if [[ ! -e "$directory" ]]; then
    install -d -o root -g root -m 0700 -- "$directory"
  fi
  [[ -d "$directory" ]] || die "Certificate storage path is not a directory: $directory."
  [[ "$(stat -c '%u:%a' -- "$directory")" == '0:700' ]] || die "Certificate storage must be root-owned mode 0700: $directory."
}

ensure_public_dir() {
  local directory=$1
  if [[ -L "$directory" ]]; then
    die "Refusing a symlink in the ACME webroot path: $directory."
  fi
  if [[ ! -e "$directory" ]]; then
    install -d -o root -g root -m 0755 -- "$directory"
  fi
  [[ -d "$directory" ]] || die "ACME webroot path is not a directory: $directory."
  [[ "$(stat -c '%u' -- "$directory")" == '0' ]] || die "ACME webroot directories must be root-owned: $directory."
  chmod 0755 -- "$directory"
}

ensure_traversable_parent() {
  local directory=$1 mode
  if [[ -L "$directory" ]]; then
    die "Refusing a symlink in the ACME webroot path: $directory."
  fi
  if [[ ! -e "$directory" ]]; then
    install -d -o root -g root -m 0711 -- "$directory"
  fi
  [[ -d "$directory" && "$(stat -c '%u' -- "$directory")" == '0' ]] || die "The ACME parent must be a root-owned directory: $directory."
  mode="$(stat -c '%a' -- "$directory")"
  (( (8#$mode & 0001) != 0 && (8#$mode & 0022) == 0 )) || die "The ACME parent must allow traversal without group/world write access: $directory."
}

check_internal_app() {
  [[ -r "$APP_CA" ]] || die 'The app issuer CA is not readable at the runbook path.'
  openssl x509 -in "$APP_CA" -noout >/dev/null 2>&1 || die 'The configured app CA file is not a readable PEM certificate.'
  local status
  status="$(curl --noproxy '*' --resolve 'localhost:8443:127.0.0.1' --cacert "$APP_CA" --silent --fail --connect-timeout 3 --max-time 10 --output /dev/null --write-out '%{http_code}' 'https://localhost:8443/health' 2>/dev/null)" || die 'The app did not pass its verified localhost HTTPS health check on port 8443.'
  if [[ "$status" != 200 ]]; then
    die 'The app did not pass its verified localhost HTTPS health check on port 8443.'
  fi
}

ensure_webroot() {
  ensure_traversable_parent /var/lib/personal-ai
  ensure_public_dir "$WEBROOT"
  ensure_public_dir "$WEBROOT/.well-known"
  ensure_public_dir "$WEBROOT/.well-known/acme-challenge"
  local unexpected
  unexpected="$(find "$WEBROOT" -mindepth 1 -maxdepth 1 ! -name .well-known -print -quit)"
  [[ -z "$unexpected" ]] || die 'The ACME webroot contains an unexpected top-level entry; inspect it before continuing.'
  unexpected="$(find "$WEBROOT/.well-known" -mindepth 1 -maxdepth 1 ! -name acme-challenge -print -quit)"
  [[ -z "$unexpected" ]] || die 'The ACME webroot contains an unexpected .well-known entry; inspect it before continuing.'
  unexpected="$(find "$WEBROOT/.well-known/acme-challenge" -mindepth 1 -print -quit)"
  [[ -z "$unexpected" ]] || die 'The ACME challenge directory is not empty; inspect and remove only stale challenge tokens before continuing.'
}

probe_http_challenge() {
  local token token_file
  token="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
  [[ "$token" =~ ^[0-9a-f]{32}$ ]] || die 'Could not create a temporary ACME path probe.'
  token_file="$WEBROOT/.well-known/acme-challenge/$token"
  PROBE_TOKEN_PATH=$token_file
  printf '%s' "$token" >"$token_file"
  chmod 0644 -- "$token_file"
  if ! curl --noproxy '*' --silent --fail --connect-timeout 3 --max-time 5 --resolve "$PUBLIC_IP:80:127.0.0.1" --output "$WORK_DIR/http-probe" "http://$PUBLIC_IP/.well-known/acme-challenge/$token" 2>/dev/null || ! cmp -s -- "$WORK_DIR/http-probe" "$token_file"; then
    die 'The local HTTP ACME challenge probe failed; keep provider traffic paused and inspect Nginx.'
  fi
  rm -f -- "$token_file"
  PROBE_TOKEN_PATH=
}

assert_nginx_include() {
  [[ -r /etc/nginx/nginx.conf ]] || die 'The expected Nginx main config is missing.'
  grep -Fq 'include /etc/nginx/conf.d/*.conf;' /etc/nginx/nginx.conf || die 'The Nginx main config does not include /etc/nginx/conf.d/*.conf.'
}

nginx_test() {
  /usr/sbin/nginx -t >/dev/null 2>&1 || die 'Nginx configuration validation failed; inspect the host config without printing secrets.'
}

assert_listener() {
  local port=$1 listeners
  listeners="$(ss -H -ltn "sport = :$port")" || die "Could not inspect TCP $port listeners."
  [[ -n "$listeners" ]] || die "Nginx is not listening on TCP $port."
}

check_certbot_version() {
  local output
  output="$("$CERTBOT" --version 2>&1)" || die 'Certbot could not report its installed version.'
  python3 - "$output" <<'PY' || die 'Certbot 5.4 or later is required for IP-address webroot certificates.'
import re
import sys

match = re.search(r'(?<!\d)(\d+)\.(\d+)(?:\.(\d+))?', sys.argv[1])
if not match or tuple(int(part or 0) for part in match.groups()) < (5, 4, 0):
    raise SystemExit(1)
PY
}

ensure_private_dirs() {
  local directory
  for directory in "$PROD_CONFIG" "$PROD_WORK" "$PROD_LOGS" "$STAGING_CONFIG" "$STAGING_WORK" "$STAGING_LOGS"; do
    ensure_private_dir "$directory"
  done
}

assert_only_expected_lineages() {
  local config_dir=$1 expected_name=$2 path name
  for path in "$config_dir"/live/*; do
    [[ -e "$path" || -L "$path" ]] || continue
    name=${path##*/}
    [[ "$name" == "$expected_name" ]] || die 'Unexpected certificate lineage exists in the dedicated Certbot config directory; inspect it before renewal.'
  done
  for path in "$config_dir"/renewal/*.conf; do
    [[ -e "$path" || -L "$path" ]] || continue
    name=${path##*/}
    [[ "$name" == "$expected_name.conf" ]] || die 'Unexpected renewal config exists in the dedicated Certbot config directory; inspect it before renewal.'
  done
}

certificate_is_usable() {
  local config_dir=$1 name=$2 lineage="$config_dir/live/$2" archive_dir key_real cert_real
  [[ -d "$lineage" && ! -L "$lineage" && -f "$lineage/fullchain.pem" && -f "$lineage/privkey.pem" ]] || return 1
  openssl x509 -in "$lineage/fullchain.pem" -noout -checkip "$PUBLIC_IP" -checkend 3600 >/dev/null 2>&1 || return 1
  archive_dir="$(realpath -e -- "$config_dir/archive/$name" 2>/dev/null)" || return 1
  key_real="$(realpath -e -- "$lineage/privkey.pem" 2>/dev/null)" || return 1
  cert_real="$(realpath -e -- "$lineage/fullchain.pem" 2>/dev/null)" || return 1
  case "$key_real" in "$archive_dir"/privkey*.pem) ;; *) return 1 ;; esac
  case "$cert_real" in "$archive_dir"/fullchain*.pem) ;; *) return 1 ;; esac
  [[ "$(stat -c '%u' -- "$key_real")" == '0' && "$(stat -c '%u' -- "$cert_real")" == '0' ]] || return 1
  chmod 0600 -- "$key_real" || return 1
}

ensure_certificate() {
  local config_dir=$1 work_dir=$2 logs_dir=$3 cert_name=$4 staging=$5 lineage="$1/live/$4" renewal="$1/renewal/$4.conf"
  local -a consent_args=()
  if [[ "${ISSUE_MODE:-interactive}" == noninteractive_no_email ]]; then
    consent_args=(--non-interactive --agree-tos --register-unsafely-without-email)
  fi
  assert_only_expected_lineages "$config_dir" "$cert_name"
  if [[ -e "$lineage" || -L "$lineage" || -e "$renewal" || -L "$renewal" ]]; then
    certificate_is_usable "$config_dir" "$cert_name" || die 'An existing certificate lineage is invalid, near expiry, or mismatched; inspect it instead of forcing a new CA issuance.'
    printf 'Using the existing verified IP certificate lineage: %s\n' "$cert_name"
    return
  fi
  if [[ "$staging" == yes ]]; then
    "$CERTBOT" certonly "${consent_args[@]}" --staging --preferred-profile shortlived --webroot --webroot-path "$WEBROOT" --ip-address "$PUBLIC_IP" --cert-name "$cert_name" --config-dir "$config_dir" --work-dir "$work_dir" --logs-dir "$logs_dir"
  else
    "$CERTBOT" certonly "${consent_args[@]}" --preferred-profile shortlived --webroot --webroot-path "$WEBROOT" --ip-address "$PUBLIC_IP" --cert-name "$cert_name" --config-dir "$config_dir" --work-dir "$work_dir" --logs-dir "$logs_dir"
  fi
  certificate_is_usable "$config_dir" "$cert_name" || die 'Certbot returned without a valid root-owned IP certificate and private key.'
}

install_renewal_units() {
  local service_source="$SCRIPT_DIR/pai-cert-renew.service" timer_source="$SCRIPT_DIR/pai-cert-renew.timer"
  local service_target=/etc/systemd/system/pai-cert-renew.service timer_target=/etc/systemd/system/pai-cert-renew.timer
  if [[ -e "$service_target" || -L "$service_target" ]]; then
    [[ -f "$service_target" && ! -L "$service_target" && "$(stat -c '%u:%a' -- "$service_target")" == '0:644' ]] || die 'An existing pai-cert-renew.service is not a root-owned regular 0644 file.'
    cmp -s -- "$service_source" "$service_target" || die 'An existing pai-cert-renew.service differs from the shipped unit; refusing to overwrite it.'
  fi
  if [[ -e "$timer_target" || -L "$timer_target" ]]; then
    [[ -f "$timer_target" && ! -L "$timer_target" && "$(stat -c '%u:%a' -- "$timer_target")" == '0:644' ]] || die 'An existing pai-cert-renew.timer is not a root-owned regular 0644 file.'
    cmp -s -- "$timer_source" "$timer_target" || die 'An existing pai-cert-renew.timer differs from the shipped unit; refusing to overwrite it.'
  fi
  [[ -e "$service_target" ]] || install -o root -g root -m 0644 -- "$service_source" "$service_target"
  [[ -e "$timer_target" ]] || install -o root -g root -m 0644 -- "$timer_source" "$timer_target"
  /bin/systemctl daemon-reload
}

verify_final_https() {
  local status
  status="$(curl --noproxy '*' --silent --fail --connect-timeout 3 --max-time 15 --resolve "$PUBLIC_IP:443:127.0.0.1" --output /dev/null --write-out '%{http_code}' "https://$PUBLIC_IP/health" 2>/dev/null)" || die 'Local verified HTTPS app health failed; browser traffic was not accepted.'
  if [[ "$status" != 200 ]]; then
    die 'Local verified HTTPS app health failed; browser traffic was not accepted.'
  fi
}

if [[ "$PHASE" == prepare ]]; then
  assert_mounted_data
  check_internal_app
  assert_nginx_include
  [[ ! -e /etc/nginx/sites-enabled/default && ! -L /etc/nginx/sites-enabled/default ]] || die 'Disable the distribution default Nginx site as directed by the runbook; this script never removes it.'
  ensure_webroot
  render_template "$SCRIPT_DIR/nginx-demo-bootstrap.conf.example" "$WORK_DIR/bootstrap.conf"
  if [[ -e "$NGINX_SITE" || -L "$NGINX_SITE" ]]; then
    cmp -s -- "$NGINX_SITE" "$WORK_DIR/bootstrap.conf" || die 'A different Nginx site already occupies the managed path; refusing to overwrite it.'
  else
    install -o root -g root -m 0644 -- "$WORK_DIR/bootstrap.conf" "$NGINX_SITE"
    if ! /usr/sbin/nginx -t >/dev/null 2>&1; then
      rm -f -- "$NGINX_SITE"
      die 'Bootstrap Nginx configuration failed validation; the new managed file was removed.'
    fi
  fi
  nginx_test
  /bin/systemctl enable --now nginx || die 'Nginx could not be enabled and started.'
  /bin/systemctl is-active --quiet nginx || die 'Nginx is not active after startup.'
  assert_listener 80
  probe_http_challenge
  printf 'Bootstrap is listening and the local ACME challenge path passed. No AWS security-group rule was changed.\n'
  printf 'Next, enable only the planned TCP 80/443 ingress while provider inference remains paused, then run the issue phase.\n'
  exit 0
fi

assert_mounted_data
check_internal_app
assert_nginx_include
ensure_webroot
check_certbot_version
ensure_private_dirs
render_template "$SCRIPT_DIR/nginx-demo-bootstrap.conf.example" "$WORK_DIR/bootstrap.conf"
render_template "$SCRIPT_DIR/nginx-demo.conf.example" "$WORK_DIR/final.conf"
BOOTSTRAP_RENDERED="$WORK_DIR/bootstrap.conf"
FINAL_RENDERED="$WORK_DIR/final.conf"
[[ ! -L "$NGINX_SITE" && -f "$NGINX_SITE" ]] || die 'The managed Nginx site is missing or is a symlink; run the prepare phase first.'
if cmp -s -- "$NGINX_SITE" "$BOOTSTRAP_RENDERED"; then
  nginx_test
elif cmp -s -- "$NGINX_SITE" "$FINAL_RENDERED"; then
  nginx_test
else
  die 'The active Nginx site is not the shipped bootstrap or final config; refusing to overwrite it.'
fi
/bin/systemctl is-active --quiet nginx || die 'Nginx must already be active before certificate issuance.'
assert_listener 80
probe_http_challenge

ensure_certificate "$STAGING_CONFIG" "$STAGING_WORK" "$STAGING_LOGS" demo-ip-staging yes
ensure_certificate "$PROD_CONFIG" "$PROD_WORK" "$PROD_LOGS" "$PUBLIC_IP" no

install_renewal_units
if cmp -s -- "$NGINX_SITE" "$BOOTSTRAP_RENDERED"; then
  install -o root -g root -m 0644 -- "$FINAL_RENDERED" "$NGINX_SITE"
  ISSUE_SWITCHED_CONFIG=1
  nginx_test
  /bin/systemctl reload nginx || die 'Nginx could not load the verified HTTPS configuration.'
fi
assert_listener 80
assert_listener 443
verify_final_https

/snap/bin/certbot renew --non-interactive --dry-run --run-deploy-hooks --config-dir "$PROD_CONFIG" --work-dir "$PROD_WORK" --logs-dir "$PROD_LOGS" --deploy-hook '/usr/sbin/nginx -t && /bin/systemctl reload nginx'

if ! /bin/systemctl is-enabled --quiet pai-cert-renew.timer; then
  ISSUE_TIMER_ENABLED=1
  /bin/systemctl enable pai-cert-renew.timer || die 'The certificate renewal timer could not be enabled.'
fi
if ! /bin/systemctl is-active --quiet pai-cert-renew.timer; then
  ISSUE_TIMER_STARTED=1
  /bin/systemctl start pai-cert-renew.timer || die 'The certificate renewal timer could not be started.'
fi
/bin/systemctl is-enabled --quiet pai-cert-renew.timer || die 'The certificate renewal timer is not enabled.'
/bin/systemctl is-active --quiet pai-cert-renew.timer || die 'The certificate renewal timer is not active.'
ISSUE_SWITCHED_CONFIG=0
ISSUE_TIMER_ENABLED=0
ISSUE_TIMER_STARTED=0
printf 'Local trusted HTTPS health and the explicit renewal dry-run passed; the Certbot timer is active.\n'
printf 'This does not complete browser, runtime-capacity, provider, or release acceptance. Keep global inference paused until those separate gates pass.\n'
