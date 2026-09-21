# Repo Health: m47/full

_Full access_

- Репозиторий: https://sourcecraft.dev/m47/full
- Скан: #1 от 2026-09-16 12:00 (статус полный, запуск по расписанию)
- Модель: 4.0.0-hci
- Язык: TypeScript; лайки: 40; форки: 5
- Последняя активность: 2026-09-10

## Итог

**HealthCraft Index (4 категории): 72 из 100 – здоров** при покрытии данными 100%.

Repo Health Score (6 категорий, с CI и Security): 65 из 100 при покрытии данными 100%.
Разницу с HealthCraft Index дают CI и Security: -7.0 – вклад двух каналов при их фактических данных.

Индекс построен из публичных данных: CI/CD и Security в нем не участвуют по правилам платформы – разницу с полным показателем дают только они.

Сильнее всего – CI/CD (90), слабее всего – Issues (40). Рекомендаций: 2; наибольший измеримый прирост дает «Нет CODEOWNERS – не видно, кто отвечает за код» (+1.5 к HealthCraft Index (по одному)).

## Категории

| Категория | Вес модели | Балл | Вклад после перенормировки | Статус |
|---|---:|---:|---:|---|
| Документация | 15% | 60 | 15% | данные есть |
| CI/CD | 15% | 90.1 | 15% | данные есть |
| Security | 20% | 50.5 | 20% | данные есть |
| Активность | 15% | 70 | 15% | данные есть |
| Issues | 15% | 40 | 15% | данные есть |
| Code health | 20% | 80 | 20% | данные есть |

## Разбор по категориям

### Документация – 60 / 100

| Подметрика | Балл (0-100) | Значение | Примечание |
|---|---:|---|---|
| readme | 72 | {"bytes":8000,"sections":5,"flags":{"install":true,"build":false,"test":false}} | — |
| license | 100 | — | — |
| contributing | 0 | — | — |
| codeowners | 0 | — | — |

### CI/CD – 90.1 / 100

| Подметрика | Балл (0-100) | Значение | Примечание |
|---|---:|---|---|
| config | 100 | {"paths":[".sourcecraft/ci.yaml"],"has_ci_yaml":true,"has_steps":true} | — |
| pass_rate | 93 | 0.95 | — |
| duration | 74 | 420 | — |

### Security – 50.5 / 100

| Подметрика | Балл (0-100) | Значение | Примечание |
|---|---:|---|---|
| density | 10 | 38 | — |
| resolved | 85 | 0.8 | — |
| secrets | 100 | false | — |

### Активность – 70 / 100

| Подметрика | Балл (0-100) | Значение | Примечание |
|---|---:|---|---|
| fresh | 90 | 1789481810000 | — |
| freq | 60 | 4.33 | — |
| contributors | 50 | 2 | — |
| pulls_90d | 40 | 3 | — |
| releases_12m | 30 | 1 | — |
| mirror_likeness | — | {"sync_share":0.13,"authors":2,"committers":3} | — |
| commits_90d | — | 13 | — |
| commits_365d | — | 40 | — |
| sync_bursts | — | 0 | — |

### Issues – 40 / 100

| Подметрика | Балл (0-100) | Значение | Примечание |
|---|---:|---|---|
| stale | 40 | 0.5 | — |
| close_days | 80 | 5 | — |
| resolution | 60 | 0.71 | — |
| first_resp | 50 | 30 | — |

### Code health – 80 / 100

| Подметрика | Балл (0-100) | Значение | Примечание |
|---|---:|---|---|
| density | 80 | 0.87 | — |
| old_share | 50 | 0.5 | — |
| root | 100 | 1 | — |
| todo_total | — | 5 | — |

## Рекомендации

Порядок задан движком: сперва измеримый прирост показателя (HealthCraft Index или Repo Health Score – смотрите строку эффекта), затем то, что открывает закрытую категорию, затем улучшения по уже собранным данным. Каждая рекомендация привязана к фактам.

### 1. Нет CODEOWNERS – не видно, кто отвечает за код

- Что сделать: Добавьте файл CODEOWNERS
- Эффект: +1.5 к HealthCraft Index (по одному)
- Факты: `docs.presence`
- Правило: `codeowners-missing` (источник: rule)

### 2. Критичные находки AppSec \(secrets/SAST critical\)

- Что сделать: Закройте критичные находки: утечки секретов капят Repo Health Score на 49
- Эффект: снимет кап Repo Health Score ≤ 49 и поднимет Security
- Факты: `appsec.findings`
- Правило: `appsec-critical` (источник: rule)

## Доказательная база

Каждое число выше получено из этих фактов. Тяжелые значения (история коммитов) показаны агрегатом – сырье коммитов не хранится и не выгружается.

| Факт (kind) | Категория | Статус | Источник | Собрано | Значение |
|---|---|---|---|---|---|
| `activity.git.summary` | activity | данные есть | git | 2026-09-16 12:00 | {"commits":2,"authors":2,"committers":2,"robot_commits":0,"robot_ratio":0,"first_committed_at":"2025-08-16T10:00:00Z","last_committed_at":"2026-09-10T10:00:00Z","history_truncated_since":"2025-08-16"} |
| `activity.git.timeline` | activity | данные есть | git | 2026-09-16 12:00 | {"events":2,"first":"2025-08-16T10:00:00Z","last":"2026-09-10T10:00:00Z","truncated":true} |
| `activity.rest` | activity | данные есть | rest:activity | 2026-09-16 12:00 | {"contributors":2,"releases":1,"pulls_open":1,"pulls_created_at":[],"releases_released_at":[]} |
| `appsec.findings` | security | данные есть | appsec:api | 2026-09-16 12:00 | {"severity_counts":{"critical":1,"high":1,"medium":2,"low":3},"resolved_share":0.8,"secrets_critical":false,"backlog":{"open_groups":4,"open_findings":7,"engines":{"sast":5,"secrets":2},"severity_raw_counts":{}},"provenance":{"scan_uuid":"u-1","commit_hash":"deadbeef","time_finished":"2026-09-16T11:… |
| `cicd.configs` | cicd | данные есть | git | 2026-09-16 12:00 | {"paths":[".sourcecraft/ci.yaml"],"has_ci_yaml":true,"has_steps":true} |
| `cicd.runs` | cicd | данные есть | rest:cicd | 2026-09-16 12:00 | {"last_status":"success","success_rate":0.95,"duration_p50":420,"runs_count":20} |
| `code.todo` | code | данные есть | git | 2026-09-16 12:00 | {"count":4,"fixme":1,"older_180d":2,"todo_files":3,"blamed_files":3} |
| `docs.presence` | documentation | данные есть | git | 2026-09-16 12:00 | {"readme":true,"license":true,"contributing":false,"codeowners":false} |
| `docs.readme` | documentation | данные есть | git | 2026-09-16 12:00 | {"bytes":8000,"sections":5,"flags":{"install":true,"build":false,"test":false}} |
| `issues.comments_sample` | issues | данные есть | rest:comments | 2026-09-16 12:00 | {"issues":4,"with_comments":2,"median_first_comment_delay_hours":30,"delays_hours":[30]} |
| `issues.stats` | issues | данные есть | rest:issues | 2026-09-16 12:00 | {"open":4,"closed":10,"median_close_days":5,"stale_90d":2,"fetched_count":14} |
| `tree.stats` | code | данные есть | git | 2026-09-16 12:00 | {"top_level":[{"name":"src","type":"tree"}],"file_count":10,"bytes":1000,"loc":5000} |
| `tree.stats@channel` | code | данные есть | git | 2026-09-16 12:00 | {"top_level":[{"name":"src","type":"tree"}],"file_count":10,"bytes":1000,"loc":5000} |

## Как считается и что это не значит

- **Два показателя:** HealthCraft Index – публичная проекция из 4 категорий (порядок в рейтинге), Repo Health Score – полный показатель из 6 категорий (кап 49 за критичные secrets). Полный считается на чтении из фактически показанных категорий и нигде не хранится.
- **Веса HealthCraft Index (публичные 4 категории):** Документация 23%, Активность 23%, Issues 23%, Code health 31% – перенормированная редукция весов полного показателя (источник и правило вывода – методика).
- **Веса Repo Health Score (номинальные):** Документация 15%, CI/CD 15%, Security 20%, Активность 15%, Issues 15%, Code health 20%. Каждый показатель – взвешенное среднее баллов категорий, у которых есть данные.
- **Перенормировка (tri-state):** категория без данных не получает ноль – ее вес выбрасывается, а веса остальных пересчитываются. Отсутствие данных никогда не ухудшает показатель.
- **Порог «недостаточно данных»:** при покрытии ниже 40% показатель не выставляется вовсе (значение NULL), потому что честного числа на таких данных нет.
- **CI/CD и Security:** в HealthCraft Index не входят (раны чужих репо и AppSec платформа публично не отдает); Repo Health Score с ними виден зрителю с доступом к этим данным. Security считается только по данным AppSec SourceCraft, доступным по правам; без них категория исключена с перенормировкой, а не занижена.
- **Что это НЕ значит:** показатели не измеряют популярность (лайки и форки в формулу не входят), не оценивают качество кода по существу и не заменяют ревью. Они измеряют наблюдаемые признаки здоровья репозитория теми данными, которые доступны.
- **Ограничения методики:** часть сигналов недоступна снаружи (статусы CI чужих репозиториев, AppSec без права доступа), крупные репозитории читаются деградационным ярусом с усеченной историей, а активность зеркал занижается детектором роботов не полностью.
- **Методика целиком:** reports/2026-09-15-m2-methodology-draft.md (раздел §12 – известные ограничения).

Отчет сформирован детерминированно из фактов скана, без участия LLM.
