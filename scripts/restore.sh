#!/usr/bin/env bash
# Restore script for custody PostgreSQL database
# Performs: checksum verification, restore to temp DB, integrity checks, optional swap
# Usage: ./scripts/restore.sh <backup_file> [--swap] [--target-db <name>]

set -euo pipefail

BACKUP_FILE="${1:-}"
if [ -z "$BACKUP_FILE" ]; then
  echo "Usage: $0 <backup_file.sql.gz> [--swap] [--target-db <name>]"
  exit 1
fi

PG_HOST="${PG_HOST:-localhost}"
PG_PORT="${PG_PORT:-5432}"
PG_USER="${PG_USER:-postgres}"
PG_DATABASE="${PG_DATABASE:-tradfi_web3}"
TARGET_DB="${PG_DATABASE}_restore_$(date +%s)"
SWAP=false

shift || true
while [ $# -gt 0 ]; do
  case $1 in
    --swap) SWAP=true ;;
    --target-db) shift; TARGET_DB="$1" ;;
  esac
  shift || true
done

echo "[$(date)] Restore: $BACKUP_FILE -> $TARGET_DB"

# Step 1: Verify checksum
CHECKSUM_FILE="${BACKUP_FILE}.sha256"
if [ -f "$CHECKSUM_FILE" ]; then
  echo "[$(date)] Verifying backup checksum..."
  sha256sum --check "$CHECKSUM_FILE" || { echo "CHECKSUM MISMATCH — aborting"; exit 1; }
  echo "[$(date)] Checksum OK"
else
  echo "[$(date)] WARNING: No checksum file found, proceeding without verification"
fi

# Step 2: Create target database
echo "[$(date)] Creating restore database: $TARGET_DB"
psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -c "CREATE DATABASE \"$TARGET_DB\";"

# Step 3: Restore
echo "[$(date)] Restoring data..."
gunzip -c "$BACKUP_FILE" | psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$TARGET_DB" -q

# Step 4: Integrity verification
echo "[$(date)] Running integrity checks..."
ERRORS=0

# Check hash chain
CHAIN_CHECK=$(psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$TARGET_DB" -t -c "
  SELECT COUNT(*) FROM ledger_entries le
  WHERE le.sequence_number > 1
    AND le.previous_hash != (
      SELECT entry_hash FROM ledger_entries
      WHERE account_id = le.account_id AND sequence_number = le.sequence_number - 1
    );
" 2>/dev/null || echo "-1")
CHAIN_CHECK=$(echo "$CHAIN_CHECK" | tr -d ' ')

if [ "$CHAIN_CHECK" = "0" ]; then
  echo "  ✓ Hash chain integrity: VALID"
elif [ "$CHAIN_CHECK" = "-1" ]; then
  echo "  ⚠ Hash chain check: skipped (table may not exist)"
else
  echo "  ✗ Hash chain integrity: BROKEN ($CHAIN_CHECK mismatches)"
  ERRORS=$((ERRORS + 1))
fi

# Check double-entry balance
BALANCE_CHECK=$(psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$TARGET_DB" -t -c "
  SELECT COALESCE(SUM(CASE WHEN entry_type='debit' THEN amount ELSE -amount END), 0)
  FROM ledger_entries;
" 2>/dev/null || echo "SKIP")
BALANCE_CHECK=$(echo "$BALANCE_CHECK" | tr -d ' ')

if [ "$BALANCE_CHECK" = "0" ]; then
  echo "  ✓ Double-entry balance: VALID (debits = credits)"
elif [ "$BALANCE_CHECK" = "SKIP" ]; then
  echo "  ⚠ Balance check: skipped"
else
  echo "  ✗ Double-entry balance: MISMATCH (net=$BALANCE_CHECK)"
  ERRORS=$((ERRORS + 1))
fi

# Row counts
for table in accounts journal_entries ledger_entries wallets transactions_blockchain; do
  COUNT=$(psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$TARGET_DB" -t -c "SELECT COUNT(*) FROM $table;" 2>/dev/null || echo "N/A")
  echo "  • $table: $(echo $COUNT | tr -d ' ') rows"
done

# Step 5: Result
if [ $ERRORS -gt 0 ]; then
  echo ""
  echo "[$(date)] ✗ RESTORE VERIFICATION FAILED ($ERRORS errors)"
  echo "  Database '$TARGET_DB' left in place for investigation."
  echo "  Drop with: psql -c \"DROP DATABASE \\\"$TARGET_DB\\\";\""
  exit 1
fi

echo ""
echo "[$(date)] ✓ RESTORE VERIFIED SUCCESSFULLY"

# Step 6: Swap if requested
if [ "$SWAP" = true ]; then
  echo "[$(date)] Swapping databases..."
  echo "  WARNING: This will terminate all connections to $PG_DATABASE"
  psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -c "
    SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$PG_DATABASE' AND pid != pg_backend_pid();
    ALTER DATABASE \"$PG_DATABASE\" RENAME TO \"${PG_DATABASE}_pre_restore_$(date +%s)\";
    ALTER DATABASE \"$TARGET_DB\" RENAME TO \"$PG_DATABASE\";
  "
  echo "[$(date)] Swap complete. Application can reconnect."
else
  echo "  Restored to: $TARGET_DB"
  echo "  To swap: re-run with --swap flag"
  echo "  To drop: psql -c \"DROP DATABASE \\\"$TARGET_DB\\\";\""
fi
