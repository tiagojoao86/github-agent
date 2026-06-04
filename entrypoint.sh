#!/bin/sh
set -e

# Garante que o diretório de logs existe e pertence ao utilizador node,
# independentemente das permissões do volume montado pelo host.
mkdir -p /app/logs
chown node:node /app/logs

exec runuser -u node -- node /app/dist/index.js
