# Развертывание на сервере

HealthCraft разворачивается на 1 виртуальной машине: 2 процесса сервиса и прокси с HTTPS в контейнерах Docker Compose. Код выкладывается скриптом `deploy/deploy.sh` с машины разработчика, образ собирается на ВМ. Секреты и база живут на ВМ и выкладкой не затрагиваются.

## Что нужно

- ВМ с Ubuntu 24.04: 4 vCPU, 8 ГБ памяти, SSD 64 ГБ, статический IP. На такой конфигурации работает https://health-craft.ru.
- Входящие TCP 22, 80 и 443 в группе безопасности или файрволе.
- Домен: A-записи основного домена и `www` указывают на IP ВМ.
- Доступ к ВМ по SSH-ключу.
- На машине разработчика – bash, git, ssh и клон репозитория HealthCraft.

## Подготовка ВМ {#podgotovka}

Подготовка выполняется 1 раз. Чтобы подготовить ВМ:

1. Установите Docker с Compose v2, а также `sqlite3` и `zstd` для резервных копий.
   ```bash
   sudo apt update && sudo apt install -y docker.io docker-compose-v2 sqlite3 zstd
   ```
2. Добавьте пользователя в группу `docker`. Изменение действует после повторного входа по SSH.
   ```bash
   sudo usermod -aG docker "$USER"
   ```
3. Создайте рабочий каталог `/srv/healthcraft`, владелец – ваш пользователь.
   ```bash
   sudo install -d -o "$USER" /srv/healthcraft
   ```
4. Создайте файл подкачки на 4 ГБ.
   ```bash
   sudo fallocate -l 4G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
   ```
5. Включите подкачку при загрузке.
   ```bash
   echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
   ```

## Секреты

Все настройки лежат в файле `/srv/healthcraft/.env` на ВМ. Чтобы его создать:

1. На машине разработчика скопируйте `.env.example` из репозитория на ВМ.
   ```bash
   scp .env.example <user>@<IP ВМ>:/srv/healthcraft/.env
   ```
2. На ВМ закройте файл от других пользователей.
   ```bash
   chmod 600 /srv/healthcraft/.env
   ```
3. Впишите `SOURCECRAFT_TOKEN` и, если нужны вход и AI, их переменные – см. [Переменные окружения](env.md).
4. Добавьте адрес сервиса. Например, для домена `hc.example.com`:
   ```ini
   SITE_ADDRESS=hc.example.com, www.hc.example.com
   CANONICAL_HOST=hc.example.com
   PUBLIC_BASE_URL=https://hc.example.com
   YA_REDIRECT_URI=https://hc.example.com/auth/ya/callback
   ```
5. Добавьте адрес из `YA_REDIRECT_URI` в OAuth-приложение Яндекс ID.

Прокси Caddy сам выпускает и продлевает сертификат HTTPS.

## Выкладка

Чтобы выложить новую версию, на машине разработчика выполните в каталоге репозитория:

```bash
deploy/deploy.sh <user>@<IP ВМ>
```

Скрипт:

1. Упаковывает код закоммиченного `HEAD` без `.env`, `data/` и зависимостей.
2. Распаковывает код в `/srv/healthcraft/app`. Прошлая версия остается в `/srv/healthcraft/app.prev`.
3. Собирает образ на ВМ и пересоздает контейнеры командой `docker compose ... up -d --build`.
4. Перезапускает прокси, чтобы он прочитал новый `Caddyfile`, и печатает состояние контейнеров.

Незакоммиченные изменения на ВМ не попадают: скрипт предупредит о них. Ключ SSH задает переменная `HC_SSH_KEY`, по умолчанию `~/.ssh/healthcraft-stand`. Контейнер `rating` стартует после того, как `web` прошел проверку готовности.

Чтобы откатиться, переключитесь в репозитории на нужный коммит и снова запустите `deploy/deploy.sh`.

## Изменение настроек {#izmenit-nastroyki}

Чтобы применить новые значения в `/srv/healthcraft/.env`:

1. Отредактируйте `/srv/healthcraft/.env` на ВМ.
2. Перейдите в каталог кода.
   ```bash
   cd /srv/healthcraft/app
   ```
3. Пересоздайте контейнеры.
   ```bash
   docker compose --env-file /srv/healthcraft/.env -f deploy/compose.yaml up -d
   ```

{% note warning %}

Команда `docker compose restart` не перечитывает `.env`: контейнер перезапустится со старыми значениями. Новые значения подхватывает только `docker compose ... up -d` – она пересоздает контейнеры, у которых изменились настройки.

{% endnote %}

## Резервные копии

Скрипт `deploy/backup.sh` копирует работающую базу без остановки сервиса, проверяет целостность копии, сжимает ее и хранит 3 последние копии в `/srv/healthcraft/backups`. Число копий задает переменная `KEEP`.

Чтобы делать копию каждую ночь, добавьте на ВМ строку в `crontab -e`, например на 01:30 UTC:

```bash
30 1 * * * /srv/healthcraft/app/deploy/backup.sh >> /srv/healthcraft/backup.log 2>&1
```

Копии лежат на том же диске, что и база. Они защищают от ошибки в данных и неудачной выкладки, но не от потери диска – для этого настройте снимки диска у облачного провайдера.

Чтобы восстановить базу из копии:

1. Перейдите в каталог кода.
   ```bash
   cd /srv/healthcraft/app
   ```
2. Остановите процессы сервиса.
   ```bash
   docker compose --env-file /srv/healthcraft/.env -f deploy/compose.yaml stop web rating
   ```
3. Распакуйте нужную копию на место базы.
   ```bash
   zstd -d -f /srv/healthcraft/backups/repo-health-<дата>.db.zst -o /srv/healthcraft/data/repo-health.db
   ```
4. Удалите журнал старой базы.
   ```bash
   rm -f /srv/healthcraft/data/repo-health.db-wal /srv/healthcraft/data/repo-health.db-shm
   ```
5. Запустите контейнеры.
   ```bash
   docker compose --env-file /srv/healthcraft/.env -f deploy/compose.yaml up -d
   ```

## Проверка состояния {#sostoyanie}

Состояние сервиса отдает `GET /api/health`:

```bash
curl https://hc.example.com/api/health
```

HTTP-статус ответа всегда 200 – смотрите на тело. Поле `ok` равно `true`, когда очереди анализа обслуживаются, а обход каталога и пересчет оценок идут без ошибок. Пока после выкладки новой версии модели идет пересчет оценок, `ok` равно `false`. Если `ok` равно `false`, массив `reasons` перечисляет, что не так: например, нет токена SourceCraft, обход каталога давно не удается или задание зависло. Фрагмент ответа, числа выдуманные:

```json
{
  "ok": true,
  "reasons": [],
  "repos": 1250,
  "queue": { "user": 0, "rating": 14 },
  "failedJobs24h": 3,
  "lastReconcileAt": "2026-09-15T09:05:12.418Z",
  "freshAsOf": "2026-09-15T09:07:55.102Z"
}
```

`queue` – заявки в очереди и в работе, `failedJobs24h` – неудачные заявки за сутки, `lastReconcileAt` – последняя успешная сверка каталога, `freshAsOf` – время последнего завершенного анализа с оценкой.

Проверка готовности контейнера `web` в Docker смотрит только на то, что сервер отвечает. Контейнер со статусом healthy может отдавать `"ok": false`, поэтому следите за телом ответа.

## Полезные ссылки

- [Сборка и запуск](run.md)
- [Переменные окружения](env.md)
- [Архитектура](architecture.md)
- [Периодический анализ и масштабирование](scaling.md)
