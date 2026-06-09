#!/usr/bin/env bash
# Backup script for custody PostgreSQL database
# Performs: full pg_dump, checksum, optional S3 upload, retention cleanup
# Usage: ./scripts/backup.sh [--upload-s3] [--retain-days 30]

set -euo pipefail

# Config (override via env)
PG_HOST="${PG_HOST:-localhost}"
PG_PORT="${PG_PORT:-5432}"
PG_DATABASE="${PG_DATABASE:-tradfi_web3}"
PG_USER="${PG_USER:-postgres}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/custody}"
S3_BUCKET="${BACKUP_S3_BUCKET:-}"
RETAIN_DAYS="${RETAIN_DAYS:-30}"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="${BACKUP_DIR}/${PG_DATABASE}_${TIMESTAMP}.sql.gz"
CHECKSUM_FILE="${BACKUP_FILE}.sha256"

UPLOAD_S3=false
for arg in "$@"; do
  case $arg in
    --upload-s3) UPLOAD_S3=true ;;
    --retain-days) shift; RETAIN_DAYS="${2:-30}" ;;
  esac
done

mkdir -p "$BACKUP_DIR"

echo "[$(date)] Starting backup of ${PG_DATABASE}@${PG_HOST}..."

# Full dump with custom format compressed
pg_dump -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$PG_DATABASE" \
  --format=plain --no-owner --no-privileges \
  --serializable-deferrable \
  | gzip > "$BACKUP_FILE"

# Generate checksum
sha256sum "$BACKUP_FILE" > "$CHECKSUM_FILE"
CHECKSUM=$(cat "$CHECKSUM_FILE" | awk '{print $1}')

# Verify checksum immediately
echo "[$(date)] Verifying backup integrity..."
sha256sum --check "$CHECKSUM_FILE"

# Get size
SIZE=$(du -h "$BACKUP_FILE" | awk '{print $1}')
echo "[$(date)] Backup complete: $BACKUP_FILE ($SIZE, sha256:${CHECKSUM:0:16}...)"

# Upload to S3 if requested
if [ "$UPLOAD_S3" = true ] && [ -n "$S3_BUCKET" ]; then
  echo "[$(date)] Uploading to s3://${S3_BUCKET}/backups/..."
  aws s3 cp "$BACKUP_FILE" "s3://${S3_BUCKET}/backups/$(basename "$BACKUP_FILE")" --sse AES256
  aws s3 cp "$CHECKSUM_FILE" "s3://${S3_BUCKET}/backups/$(basename "$CHECKSUM_FILE")" --sse AES256
  echo "[$(date)] S3 upload complete"
fi

# Retention: delete local backups older than RETAIN_DAYS
find "$BACKUP_DIR" -name "${PG_DATABASE}_*.sql.gz*" -mtime +"$RETAIN_DAYS" -delete 2>/dev/null || true

echo "[$(date)] Backup pipeline finished successfully"
echo "  File: $BACKUP_FILE"
echo "  SHA256: $CHECKSUM"
echo "  Size: $SIZE"
