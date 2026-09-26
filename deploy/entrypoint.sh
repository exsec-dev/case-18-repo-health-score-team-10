#!/bin/sh
# HealthCraft — вход контейнера (В5.4). Стартует от root только для одного: каталоги томов
# (/data, /tmp/clones), которые Docker создал сам (от root) или которые принадлежат другому
# uid хоста, отдаются пользователю bun. Дальше процесс работает от bun (без root).
# Проверка README на чистой копии 26.09: без этого `web` падал SQLITE_CANTOPEN на новом HC_DIR.
set -e
for d in /data /tmp/clones; do
  mkdir -p "$d"
  if [ -n "$(find "$d" ! -user bun -print -quit)" ]; then
    chown -R bun:bun "$d"
  fi
done
exec setpriv --reuid=bun --regid=bun --init-groups "$@"
