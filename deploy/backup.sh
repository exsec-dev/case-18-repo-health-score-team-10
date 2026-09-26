#!/usr/bin/env bash
# HealthCraft — резервная копия БД стенда (В5.4). Запускается на ВМ по расписанию (cron).
#
# VACUUM INTO — согласованная копия работающей БД без остановки сервиса (одна читающая
# транзакция; писатели не ждут). Копия сжимается zstd, хранятся последние KEEP штук.
# Копии лежат на том же диске: от ошибки в данных и неудачной выкладки защищают, от потери
# диска — нет (для этого — расписание снимков диска в консоли Yandex Cloud).
#
#   HC_DIR — каталог стенда (по умолчанию /srv/healthcraft); KEEP — сколько копий (3)
set -euo pipefail

DIR="${HC_DIR:-/srv/healthcraft}"
KEEP="${KEEP:-3}"
OUT="$DIR/backups"
STAMP="$(date -u +%Y%m%d-%H%M)"
mkdir -p "$OUT"

TMP="$OUT/.repo-health-$STAMP.db"
sqlite3 -cmd '.timeout 60000' "$DIR/data/repo-health.db" "VACUUM INTO '$TMP'"
CHECK="$(sqlite3 "$TMP" 'PRAGMA quick_check')"
if [ "$CHECK" != "ok" ]; then
  echo "backup $STAMP: quick_check failed: $CHECK" >&2
  rm -f "$TMP"
  exit 1
fi
zstd -q -T0 --rm "$TMP" -o "$OUT/repo-health-$STAMP.db.zst"

# ротация: оставить KEEP самых свежих
ls -1t "$OUT"/repo-health-*.db.zst | tail -n +"$((KEEP + 1))" | xargs -r rm -f
echo "backup $STAMP: $(du -h "$OUT/repo-health-$STAMP.db.zst" | cut -f1), kept $(ls -1 "$OUT"/repo-health-*.db.zst | wc -l)"
