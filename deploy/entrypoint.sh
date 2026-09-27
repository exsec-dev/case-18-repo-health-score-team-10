#!/bin/sh
# HealthCraft — вход контейнера. Стартует от root только для одного: каталоги томов
# (/data, /tmp/clones), которые Docker создал сам (от root) или которые принадлежат другому
# uid хоста, отдаются пользователю bun. Дальше процесс работает от bun (без root).
# Без этого на новом HC_DIR `web` падает с SQLITE_CANTOPEN.
set -e
# /tmp/clones — свой том у каждого контейнера (compose: tmp/web, tmp/rating): на старте живых
# клонов в нем нет, все rh-clone-* — сироты прерванного процесса (SIGTERM гасит git, но каталог
# остается; свип сервиса берет только старше 2 лизов). Без чистки сироты копятся с каждой
# выкладкой, и одна может весить сотни мегабайт.
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
