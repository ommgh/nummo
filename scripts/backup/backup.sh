#!/bin/sh
# Nightly logical backup of the nummo database to S3-compatible storage
# (Cloudflare R2, Backblaze B2, AWS S3, a Railway bucket...), run as a cron job.
#
# Required:
#   DATABASE_URL            the database to dump
#   BACKUP_S3_BUCKET        bucket name
#   BACKUP_S3_ENDPOINT      e.g. https://<account>.r2.cloudflarestorage.com
#   BACKUP_S3_ACCESS_KEY_ID, BACKUP_S3_SECRET_ACCESS_KEY
# Optional:
#   BACKUP_S3_REGION        default auto
#   BACKUP_PREFIX           folder in the bucket, default nummo
#   BACKUP_KEEP_DAYS        delete dumps older than this, default 30
#   BACKUP_PASSPHRASE       encrypt each dump (AES-256, PBKDF2) before it leaves the server
#   BACKUP_HEARTBEAT_URL    pinged after a successful run (e.g. a Healthchecks.io check), and
#                           at <url>/fail after a failed one
#   BACKUP_REMOTE           an rclone remote to use instead of the S3 settings (tests use a local path)
set -eu

fail() {
  echo "backup failed: $*" >&2
  [ -n "${BACKUP_HEARTBEAT_URL:-}" ] && wget -q -O /dev/null -T 10 "${BACKUP_HEARTBEAT_URL%/}/fail" || true
  exit 1
}

: "${DATABASE_URL:?DATABASE_URL is required}"
prefix="${BACKUP_PREFIX:-nummo}"
keep="${BACKUP_KEEP_DAYS:-30}"
if [ -n "${BACKUP_REMOTE:-}" ]; then
  remote="$BACKUP_REMOTE"
else
  : "${BACKUP_S3_BUCKET:?BACKUP_S3_BUCKET is required}" "${BACKUP_S3_ENDPOINT:?}" "${BACKUP_S3_ACCESS_KEY_ID:?}" "${BACKUP_S3_SECRET_ACCESS_KEY:?}"
  export RCLONE_S3_PROVIDER=Other RCLONE_S3_ENDPOINT="$BACKUP_S3_ENDPOINT" RCLONE_S3_REGION="${BACKUP_S3_REGION:-auto}" \
    RCLONE_S3_ACCESS_KEY_ID="$BACKUP_S3_ACCESS_KEY_ID" RCLONE_S3_SECRET_ACCESS_KEY="$BACKUP_S3_SECRET_ACCESS_KEY" RCLONE_S3_NO_CHECK_BUCKET=true
  remote=":s3:$BACKUP_S3_BUCKET"
fi

stamp=$(date -u +%Y-%m-%dT%H%M%SZ)
work=$(mktemp -d)
file="$work/nummo-$stamp.dump"

echo "dumping database"
pg_dump --format=custom --compress=9 --no-owner --no-privileges --dbname="$DATABASE_URL" --file="$file" || fail "pg_dump"
# A dump that pg_restore cannot read is worse than none: check it before uploading.
tables=$(pg_restore --list "$file" | grep -c " TABLE DATA ") || fail "pg_restore cannot read the dump"
[ "$tables" -gt 0 ] || fail "the dump holds no table data"
echo "dump ok: $(du -h "$file" | cut -f1), $tables tables"

if [ -n "${BACKUP_PASSPHRASE:-}" ]; then
  openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -in "$file" -out "$file.enc" -pass env:BACKUP_PASSPHRASE || fail "encryption"
  rm -f "$file"
  file="$file.enc"
fi

echo "uploading $(basename "$file")"
rclone copyto "$file" "$remote/$prefix/$(basename "$file")" --retries 3 || fail "upload"
echo "removing dumps older than $keep days"
rclone delete "$remote/$prefix" --min-age "${keep}d" --include "nummo-*.dump*" || fail "pruning old dumps"
rm -rf "$work"

[ -n "${BACKUP_HEARTBEAT_URL:-}" ] && wget -q -O /dev/null -T 10 "$BACKUP_HEARTBEAT_URL" || true
echo "backup done: $prefix/$(basename "$file")"
