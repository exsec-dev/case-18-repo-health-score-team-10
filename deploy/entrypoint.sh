#!/bin/sh
# HealthCraft — вход контейнера. Процесс работает от пользователя bun (USER в Dockerfile),
# root не нужен: каталоги томов /data и /tmp/clones на хосте должны принадлежать uid 1000
# (deploy/deploy.sh делает chown при создании каталогов стенда). Иначе на новом HC_DIR
# `web` падал бы с SQLITE_CANTOPEN – здесь это ловится заранее понятной ошибкой.
set -e
for d in /data /tmp/clones; do
  if [ ! -d "$d" ] || [ ! -w "$d" ]; then
    echo "hc-entrypoint: каталог $d недоступен на запись пользователю uid $(id -u): на хосте выполните chown -R 1000:1000 для data/ и tmp/ в HC_DIR" >&2
    exit 1
  fi
done
# /tmp/clones — свой том у каждого контейнера (compose: tmp/web, tmp/rating): на старте живых
# клонов в нем нет, все rh-clone-* — сироты прерванного процесса (SIGTERM гасит git, но каталог
# остается; свип сервиса берет только старше 2 лизов). Без чистки сироты копятся с каждой
# выкладкой, и одна может весить сотни мегабайт.
find /tmp/clones -mindepth 1 -maxdepth 1 -name 'rh-*' -exec rm -rf {} + 2>/dev/null || true
exec "$@"
