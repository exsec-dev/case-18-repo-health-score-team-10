#!/usr/bin/env bash
# HealthCraft — выкладка на стенд (В5.4).
#
# Везет на ВМ код ЗАКОММИЧЕННОГО HEAD (git archive: без .env, data/, node_modules),
# собирает образ на ВМ и перезапускает контейнеры. Секреты и БД живут на ВМ в HC_DIR
# и выкладкой не трогаются. Предыдущая версия кода остается в HC_DIR/app.prev (откат —
# deploy/deploy.sh с нужного коммита).
#
# Использование:  deploy/deploy.sh user@host
#   HC_SSH_KEY — ключ SSH (по умолчанию ~/.ssh/healthcraft-stand)
#   HC_DIR     — каталог стенда на ВМ (по умолчанию /srv/healthcraft)
set -euo pipefail

HOST="${1:-${HC_HOST:-}}"
[ -n "$HOST" ] || { echo "укажите user@host (или HC_HOST)" >&2; exit 2; }
KEY="${HC_SSH_KEY:-$HOME/.ssh/healthcraft-stand}"
DIR="${HC_DIR:-/srv/healthcraft}"
REV="$(git rev-parse --short HEAD)"

if [ -n "$(git status --porcelain)" ]; then
  echo "внимание: в рабочем дереве есть незакоммиченные изменения — на стенд едет только коммит $REV" >&2
fi

ssh_stand() { ssh -i "$KEY" -o BatchMode=yes "$HOST" "$@"; }

echo "==> код $REV -> $HOST:$DIR/app"
git archive --format=tar HEAD | ssh_stand "set -e
  mkdir -p '$DIR/data' '$DIR/tmp/web' '$DIR/tmp/rating'
  rm -rf '$DIR/app.new' && mkdir -p '$DIR/app.new'
  tar -x -C '$DIR/app.new'
  echo '$REV' > '$DIR/app.new/REVISION'
  rm -rf '$DIR/app.prev'
  if [ -d '$DIR/app' ]; then mv '$DIR/app' '$DIR/app.prev'; fi
  mv '$DIR/app.new' '$DIR/app'"

echo "==> сборка и перезапуск"
ssh_stand "set -e
  test -f '$DIR/.env' || { echo 'нет $DIR/.env — секреты стенда не заданы' >&2; exit 1; }
  cd '$DIR/app'
  docker compose --env-file '$DIR/.env' -f deploy/compose.yaml up -d --build --remove-orphans
  docker compose --env-file '$DIR/.env' -f deploy/compose.yaml ps"
