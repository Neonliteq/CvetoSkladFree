#!/usr/bin/env bash
# Обновление работающей установки: копия базы, новый код, сборка, схема, перезапуск.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/florasklad}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/florasklad}"
SERVICE="${SERVICE:-florasklad-api}"

cd "${APP_DIR}"

echo "== 1/6 Резервная копия базы =="
mkdir -p "${BACKUP_DIR}"
# shellcheck disable=SC1091
set -a; source .env; set +a
STAMP="$(date +%Y-%m-%d-%H%M)"
pg_dump "${DATABASE_URL}" > "${BACKUP_DIR}/sklad-${STAMP}.dump"
echo "  сохранено: ${BACKUP_DIR}/sklad-${STAMP}.dump"

echo "== 2/6 Новый код =="
git pull --ff-only

echo "== 3/6 Зависимости =="
pnpm install --frozen-lockfile

echo "== 4/6 Сборка =="
pnpm run build

echo "== 5/6 Схема базы =="
pnpm --filter @workspace/db run push

echo "== 6/6 Перезапуск службы =="
systemctl restart "${SERVICE}"
systemctl is-active "${SERVICE}" >/dev/null && echo "Служба работает"
