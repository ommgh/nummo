#!/bin/sh
# Restore a dump made by backup.sh into a database.
#
#   scripts/backup/restore.sh nummo-2026-11-18T030000Z.dump[.enc] postgres://user:pass@host:5432/nummo_restore
#
# Restore into a NEW, empty database and check it before pointing anything at it.
# Encrypted dumps (.enc) need BACKUP_PASSPHRASE. Needs pg_restore 18 and openssl.
set -eu
dump="${1:?usage: restore.sh <dump file> <database url>}"
url="${2:?usage: restore.sh <dump file> <database url>}"
if [ "${dump%.enc}" != "$dump" ]; then
  : "${BACKUP_PASSPHRASE:?BACKUP_PASSPHRASE is required for an encrypted dump}"
  plain="${dump%.enc}"
  openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -in "$dump" -out "$plain" -pass env:BACKUP_PASSPHRASE
  dump="$plain"
fi
pg_restore --no-owner --no-privileges --exit-on-error --dbname="$url" "$dump"
echo "restored $dump"
