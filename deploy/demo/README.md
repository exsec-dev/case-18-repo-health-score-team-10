# Демо HealthCraft

Демо – снимок рейтинга только для просмотра: 1000 репозиториев SourceCraft на ноябрь 2026,
по всей шкале оценок. Работают рейтинг, карточки, рекомендации, история оценки, сравнение,
отчеты, бейджи, публичный API и документация. Входа, анализа по кнопке, AI-обзоров и
личных разделов нет.

Код демо живет в ветке `demo`, полная версия – в `main`.

## Что включает демо

| Настройка | Что делает |
|---|---|
| `DEMO_MODE=1` | ключи SourceCraft, Я ID, `APP_SECRET` и моделей не читаются, роль процесса – `web`; интерфейс прячет вход, «Мои репозитории», «Избранное» и «Настройки», внизу меню – пометка «Демо» |
| `BASE_PATH=/healthcraft` | сервис отвечает под путем: страницы, API и файлы интерфейса – `/healthcraft/...` |
| `PUBLIC_BASE_URL` | адрес для кода бейджа и ссылки в PDF документации |

## Выкладка

Нужны Docker с compose и обратный прокси с HTTPS (Caddy или nginx).

1. Склонируйте ветку демо:
   ```bash
   git clone -b demo https://github.com/exsec-dev/case-18-repo-health-score-team-10.git /srv/healthcraft-demo/app
   ```
2. Положите базу демо (`healthcraft-demo-20261105.db`) в каталог данных:
   ```bash
   mkdir -p /srv/healthcraft-demo/data
   ```
   ```bash
   cp healthcraft-demo-20261105.db /srv/healthcraft-demo/data/repo-health.db
   ```
   ```bash
   sudo chown -R 1000:1000 /srv/healthcraft-demo/data
   ```
3. Соберите образ и запустите:
   ```bash
   cd /srv/healthcraft-demo/app && docker compose -f deploy/demo/compose.yaml up -d --build
   ```
4. Проверьте, что сервис отвечает:
   ```bash
   curl -s http://127.0.0.1:8418/healthcraft/api/meta
   ```
5. Настройте прокси. Путь передается как есть, без отрезания `/healthcraft`.

   Caddy, в блоке сайта `exsec.dev`:
   ```
   handle /healthcraft* {
       reverse_proxy 127.0.0.1:8418
   }
   ```

   nginx, в `server` для `exsec.dev`:
   ```nginx
   location /healthcraft {
       proxy_pass http://127.0.0.1:8418;
       proxy_set_header Host $host;
       proxy_set_header X-Forwarded-For $remote_addr;
       proxy_set_header X-Forwarded-Proto $scheme;
   }
   ```

Обновление – `git pull` в `/srv/healthcraft-demo/app` и та же команда `up -d --build`.
База не меняется: обхода каталога в демо нет.

## Ресурсы

Один процесс Bun: около 200 МБ памяти в работе, до 420 МБ на старте, пока собирается интерфейс.
Процессор нужен только на запросы. База – 270 МБ. В `compose.yaml` заданы лимиты
640 МБ памяти и полпроцессора.

## Локальный запуск

Без Docker, из каталога с отдельным `.env`: сервис читает `.env` из текущего каталога,
поэтому из каталога проекта он подхватил бы рабочие ключи.

```ini
DEMO_MODE=1
BASE_PATH=/healthcraft
PORT=8421
DATA_DIR=/путь/к/data
PUBLIC_BASE_URL=http://localhost:8421/healthcraft
```

```bash
bun /путь/к/репозиторию/src/server.ts
```

Демо откроется на http://localhost:8421/healthcraft/.
