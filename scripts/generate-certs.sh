#!/usr/bin/env bash
# Generates a self-signed CA + server + client certificate for TLS/mTLS dev/testing.
# Usage: ./scripts/generate-certs.sh [output_dir]

set -euo pipefail

OUTDIR="${1:-./certs}"
DAYS=365
CN_CA="custody-ca"
CN_SERVER="custody-server"
CN_CLIENT="custody-client"

mkdir -p "$OUTDIR"

echo "==> Generating CA..."
openssl genrsa -out "$OUTDIR/ca.key" 4096
openssl req -new -x509 -days "$DAYS" -key "$OUTDIR/ca.key" \
  -out "$OUTDIR/ca.crt" -subj "/CN=$CN_CA/O=Custody Infrastructure/OU=Security"

echo "==> Generating server certificate..."
openssl genrsa -out "$OUTDIR/server.key" 2048
openssl req -new -key "$OUTDIR/server.key" \
  -out "$OUTDIR/server.csr" -subj "/CN=$CN_SERVER/O=Custody Infrastructure/OU=custody-services"
openssl x509 -req -days "$DAYS" -in "$OUTDIR/server.csr" \
  -CA "$OUTDIR/ca.crt" -CAkey "$OUTDIR/ca.key" -CAcreateserial \
  -out "$OUTDIR/server.crt" \
  -extfile <(printf "subjectAltName=DNS:localhost,DNS:custody-server,IP:127.0.0.1")

echo "==> Generating client certificate (for mTLS)..."
openssl genrsa -out "$OUTDIR/client.key" 2048
openssl req -new -key "$OUTDIR/client.key" \
  -out "$OUTDIR/client.csr" -subj "/CN=$CN_CLIENT/O=Custody Infrastructure/OU=institutional-infra"
openssl x509 -req -days "$DAYS" -in "$OUTDIR/client.csr" \
  -CA "$OUTDIR/ca.crt" -CAkey "$OUTDIR/ca.key" -CAcreateserial \
  -out "$OUTDIR/client.crt"

rm -f "$OUTDIR"/*.csr "$OUTDIR"/*.srl

echo "==> Certificates generated in $OUTDIR/"
echo "    Server: TLS_CERT_PATH=$OUTDIR/server.crt TLS_KEY_PATH=$OUTDIR/server.key"
echo "    CA:     TLS_CA_PATH=$OUTDIR/ca.crt"
echo "    Client: $OUTDIR/client.crt + $OUTDIR/client.key"
echo ""
echo "    Start with TLS:  TLS_ENABLED=true TLS_CERT_PATH=$OUTDIR/server.crt TLS_KEY_PATH=$OUTDIR/server.key npm run dev"
echo "    Start with mTLS: TLS_ENABLED=true MTLS_ENABLED=true TLS_CA_PATH=$OUTDIR/ca.crt TLS_CERT_PATH=$OUTDIR/server.crt TLS_KEY_PATH=$OUTDIR/server.key npm run dev"
