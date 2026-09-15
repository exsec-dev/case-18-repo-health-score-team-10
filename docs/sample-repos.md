# Тестовая выборка репозиториев SourceCraft

Ручной файл: правим руками по мере надобности. Проверено 15.09.2026
(каталог sourcecraft.dev/find/repositories + шаллоу-клоны). Факты «CI» =
наличие `.sourcecraft/` в корне (CI-конфиг платформы), проверено клоном
или веб-деревом.

Формат git-URL (публичные репо клонируются анонимно, без токена):

```
https://git@git.sourcecraft.dev/{org}/{repo}.git
```

## Выборка по ролям

### CI есть

| Репо | Язык | Активность | CI-файлы | README/Lic | Роль в тестах |
|---|---|---|---|---|---|
| [k-5-45mm/dozzle-plus](https://sourcecraft.dev/k-5-45mm/dozzle-plus) | Go | 15.09.2026 | ci.yaml + branches.yaml + review.yaml + sites.yaml | Y/Y | «здоровый живой с CI»: полный набор автоматизаций, 79 MR / 73 issues |
| [hex21h/datahint](https://sourcecraft.dev/hex21h/datahint) | Go | 22.05.2026 (заморожен, заявлено в описании) | ci.yaml | Y/Y | «stale с CI»: конфиг есть, живёт ли — проверять по прогонам |
| [yandex-cloud-examples/cloudapp-hugo](https://sourcecraft.dev/yandex-cloud-examples/cloudapp-hugo) | JS | 12.01.2026 | ci.yaml | Y/N | минимальный CI-репо (7 файлов) |
| [sourcecraft/yc-ci-cd-serverless](https://sourcecraft.dev/sourcecraft/yc-ci-cd-serverless) | HTML | 24.09.2025 | ci.yaml (веб-дерево) | Y/N | официальный CI/CD-шаблон от SourceCraft |
| [sourcecraft/appsec](https://sourcecraft.dev/sourcecraft/appsec) | Kotlin | 23.07.2026 | ci.yaml + review.yaml + **security/** | Y/Y | движки AppSec-сканирования; `.sourcecraft/security/licenses.yaml` — риск-матрица лицензий (SCA). Зонд для вопроса 2 |

### CI нет

| Репо | Язык | Активность | README/Lic | Роль в тестах |
|---|---|---|---|---|
| [a13xp0p0v/kernel-hardening-checker](https://sourcecraft.dev/a13xp0p0v/kernel-hardening-checker) | Python | 13.09.2026 | Y/Y | контрольный кейс tri-state: активный популярный (3.2K лайков) без CI — no-data ≠ плохо |
| [divkit/divkit](https://sourcecraft.dev/divkit/divkit) | Kotlin | 15.09.2026 | Y/Y + CONTRIBUTING | зеркало GitHub (sync каждые ~2ч); доки отличные, SC-CI нет |
| [gravity-ui/uikit](https://sourcecraft.dev/gravity-ui/uikit) | TSX | 15.09.2026 | Y/Y | активное зеркало TS (2035 MR); ci-no проверен клоном |
| [testplane/testplane](https://sourcecraft.dev/testplane/testplane) | TypeScript | 14.09.2026 | Y/Y | активное TS-зеркало без SC-CI |
| [manytask/manytask](https://sourcecraft.dev/manytask/manytask) | Python | 15.09.2026 | Y/Y | маленький активный без CI |
| [bayselonarrend/openintegrations](https://sourcecraft.dev/bayselonarrend/openintegrations) | 1C | 15.09.2026 | Y/Y | большой: ~19K файлов, ~195МБ рабочая копия (голый клон .git ≈ 776МБ — CONTEXT); граница «крупного» ТЗ — 10K файлов |
| [mairamscpsl/parser-tekstov-osetinskogo-iazyka](https://sourcecraft.dev/mairamscpsl/parser-tekstov-osetinskogo-iazyka) | Python | 26.03.2026 | **N**/N | нет README — кейс «документация отсутствует» |
| [plusovichki/priplusnutaya-laba-1](https://sourcecraft.dev/plusovichki/priplusnutaya-laba-1) | C++ | 08.04.2026 | Y/N | студенческая лаба (10 файлов) — низ здоровья честный |
| [raph/its-wednesday-my-dudes](https://sourcecraft.dev/raph/its-wednesday-my-dudes) | — | 01.10.2025 | Y/N | мем-репо (README-only) — анти-паттерн «звёздность ≠ здоровье» |

## Примечания (найдено при проверке)

- **CI-маркер:** `.sourcecraft/ci.yaml` — конфиг CI/CD платформы; рядом
  бывают branches.yaml / review.yaml / sites.yaml / security/. Детект CI =
  дерево файлов, механически.
- **Зеркала:** репо вида «Synced from github.com/…» синкаются роботом
  (~каждые 2 часа); их «активность» — это синк-боты, не люди. У зеркал
  SC-CI обычно нет (CI живёт на исходной платформе). Метрика активности
  должна это учитывать (анти-накрутка).
- **AppSec:** `.sourcecraft/security/*.yaml` — конфиг-поверхность AppSec
  в самом репо (пример licenses.yaml — SCA-риски лицензий). Где живые
  результаты сканов (SAST/SCA/secrets) — открытый вопрос 2 канвы.
- **Анонимный git:** git.sourcecraft.dev отдаёт публичные репо без токена
  (REST API при этом 401-на-всё). Крупные репо для нагрузочных тестов
  брать отсюда.
- TODO/FIXME-файлы есть у: uikit (27 файлов), testplane (25), manytask
  (34), kernel-hardening-checker (3), dozzle-plus (4) — годится под
  категорию Code health.
