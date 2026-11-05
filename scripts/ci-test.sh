#!/bin/sh
# Тесты в CI. Диск раннера бывает медленным на fsync: на раннере SourceCraft те
# же тесты шли в 20-500 раз дольше (82 мс -> 40 с), набор не укладывался в
# max_cube_duration. Поэтому:
# - SQLite тестов без fsync на коммит (RH_SQLITE_SYNC_OFF, см. openDb);
# - временные БД (mkdtemp в os.tmpdir) в /dev/shm, если там от 256 МБ
#   свободных (пик за прогон ~50 МБ, а по умолчанию /dev/shm в Docker 64 МБ).
set -eu

df -h /tmp /dev/shm 2>/dev/null || true

shm_kb=$(df -Pk /dev/shm 2>/dev/null | awk 'NR==2 {print $4}')
if [ -n "${shm_kb:-}" ] && [ "$shm_kb" -ge 262144 ] && mkdir -p /dev/shm/rh-tests 2>/dev/null; then
  export TMPDIR=/dev/shm/rh-tests
fi
echo "TMPDIR=${TMPDIR:-/tmp}"

export RH_SQLITE_SYNC_OFF=1

# лимит теста 30 с: на раннере тесты с временной БД идут 4-7 с, дефолтные 5 с дают флаки; зависание все равно ловит таймаут задачи CI
exec bun test --timeout 30000
