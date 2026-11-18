# Nightly database backup job (see backup.sh). The client major version must be
# at least the server's: Railway's Postgres here is 18.
FROM postgres:18-alpine
RUN apk add --no-cache rclone openssl
COPY backup.sh /usr/local/bin/nummo-backup
RUN chmod +x /usr/local/bin/nummo-backup
USER postgres
CMD ["nummo-backup"]
