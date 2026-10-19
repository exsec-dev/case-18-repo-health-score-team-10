#!/bin/sh
# Тесты в CI SourceCraft. Временные БД тестов (mkdtemp в os.tmpdir) кладем в
# /dev/shm, если там хватает места: SQLite в WAL делает fsync на каждый
# коммит, и на медленном диске раннера 19.10 те же тесты шли в 20-500 раз
# дольше (82 мс -> 40 с), набор не укладывался в max_cube_duration.
# Пик временных файлов за прогон ~50 МБ; берем /dev/shm от 256 МБ свободных.
set -eu

df -h /tmp /dev/shm 2>/dev/null || true

shm_kb=$(df -Pk /dev/shm 2>/dev/null | awk 'NR==2 {print $4}')
if [ -n "${shm_kb:-}" ] && [ "$shm_kb" -ge 262144 ] && mkdir -p /dev/shm/rh-tests 2>/dev/null; then
  export TMPDIR=/dev/shm/rh-tests
fi
echo "TMPDIR=${TMPDIR:-/tmp}"

# лимит теста 30 с: на раннере тесты с временной БД идут 4-7 с, дефолтные 5 с дают флаки; зависание все равно ловит max_cube_duration
exec bun test --timeout 30000
