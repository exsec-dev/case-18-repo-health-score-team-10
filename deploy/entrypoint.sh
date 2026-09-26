#!/bin/sh
# HealthCraft — вход контейнера (В5.4). Стартует от root только для одного: каталоги томов
# (/data, /tmp/clones), которые Docker создал сам (от root) или которые принадлежат другому
# uid хоста, отдаются пользователю bun. Дальше процесс работает от bun (без root).
# Проверка README на чистой копии 26.09: без этого `web` падал SQLITE_CANTOPEN на новом HC_DIR.
set -e
# /tmp/clones — свой том у каждого контейнера (compose: tmp/web, tmp/rating): на старте живых
# клонов в нем нет, все rh-clone-* — сироты прерванного процесса (SIGTERM гасит git, но каталог
# остается; свип сервиса берет только старше 2 лизов). Проверка стенда 26.09: 4 сироты за 4 выкладки,
# одна — 665 МБ.
if [ -d /tmp/clones ]; then
  find /tmp/clones -mindepth 1 -maxdepth 1 -name 'rh-*' -exec rm -rf {} +
fi
for d in /data /tmp/clones; do
  mkdir -p "$d"
  if [ -n "$(find "$d" ! -user bun -print -quit)" ]; then
    chown -R bun:bun "$d"
  fi
done
exec setpriv --reuid=bun --regid=bun --init-groups "$@"
