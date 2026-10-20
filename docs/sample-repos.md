# Тестовая выборка репозиториев SourceCraft

Ручной файл: правим руками по мере надобности. Проверено 15.09.2026
(каталог sourcecraft.dev/find/repositories + шаллоу-клоны). Факты «CI» =
наличие `.sourcecraft/ci.yaml` в корне (CI-конфиг платформы), проверено
клоном или веб-деревом. Сборщик смотрит ровно на этот путь
(`src/collectors/git.ts`, факт `cicd.configs`: `has_ci_yaml` + `has_steps`).

Формат git-URL (публичные репо клонируются анонимно, без токена, пользователь
`git` – так URL собирает `scanGitUrl` в `src/jobs/runner.ts`):

```
https://git@git.sourcecraft.dev/{org}/{repo}.git
```

Все 14 репо выборки пересканирует одним прогоном `bun scripts/rescan-m2.ts`
(без обхода каталога, общий бюджет REST-запросов на прогон). Разовый скан и
пересчет одного репо – `bun scripts/scan.ts <org/repo>` и
`bun scripts/score.ts <org/repo>`.

## Выборка по ролям

### CI есть

| Репо | Язык | Активность | CI-файлы | README/Lic | Роль в тестах |
|---|---|---|---|---|---|
| [k-5-45mm/dozzle-plus](https://sourcecraft.dev/k-5-45mm/dozzle-plus) | Go | 15.09.2026 | ci.yaml + branches.yaml + review.yaml + sites.yaml | Y/Y | «здоровый живой с CI»: полный набор автоматизаций, 79 MR / 73 issues; цель зондов REST (`scripts/probe-rest.ts`), ci.yaml – фикстура `tests/fixtures/ci/` |
| [hex21h/datahint](https://sourcecraft.dev/hex21h/datahint) | Go | 22.05.2026 (заморожен, заявлено в описании) | ci.yaml | Y/Y | «stale с CI»: конфиг есть, живет ли – видно только по запускам, а они доступны лишь зрителю с правами на CI/CD репо; ci.yaml – фикстура `tests/fixtures/ci/` |
| [yandex-cloud-examples/cloudapp-hugo](https://sourcecraft.dev/yandex-cloud-examples/cloudapp-hugo) | JS | 12.01.2026 | ci.yaml | Y/N | минимальный CI-репо (7 файлов); ci.yaml – фикстура `tests/fixtures/ci/` |
| [sourcecraft/yc-ci-cd-serverless](https://sourcecraft.dev/sourcecraft/yc-ci-cd-serverless) | HTML | 24.09.2025 | ci.yaml (веб-дерево) | Y/N | официальный CI/CD-шаблон от SourceCraft |
| [sourcecraft/appsec](https://sourcecraft.dev/sourcecraft/appsec) | Kotlin | 23.07.2026 | ci.yaml + review.yaml + **security/** | Y/Y | движки AppSec-сканирования; `.sourcecraft/security/licenses.yaml` – риск-матрица лицензий (SCA). Репо-зонд для проверки AppSec API (`scripts/probe-appsec*.ts`) |

### CI нет

| Репо | Язык | Активность | README/Lic | Роль в тестах |
|---|---|---|---|---|
| [a13xp0p0v/kernel-hardening-checker](https://sourcecraft.dev/a13xp0p0v/kernel-hardening-checker) | Python | 13.09.2026 | Y/Y | контрольный кейс tri-state: активный популярный (3.2K лайков) без CI – в публичный HealthCraft Index категория CI/CD не входит, без доступа к запускам она «нет данных», а не 0 |
| [divkit/divkit](https://sourcecraft.dev/divkit/divkit) | Kotlin | 15.09.2026 | Y/Y + CONTRIBUTING | зеркало GitHub (sync каждые ~2ч); доки отличные, SC-CI нет |
| [gravity-ui/uikit](https://sourcecraft.dev/gravity-ui/uikit) | TSX | 15.09.2026 | Y/Y | активное зеркало TS (2035 MR); ci-no проверен клоном |
| [testplane/testplane](https://sourcecraft.dev/testplane/testplane) | TypeScript | 14.09.2026 | Y/Y | активное TS-зеркало без SC-CI |
| [manytask/manytask](https://sourcecraft.dev/manytask/manytask) | Python | 15.09.2026 | Y/Y | маленький активный без CI |
| [bayselonarrend/openintegrations](https://sourcecraft.dev/bayselonarrend/openintegrations) | 1C | 15.09.2026 | Y/Y | большой: ~19K файлов, ~195МБ рабочая копия (голый клон .git ≈ 776МБ – укладывается в первый ярус бюджета клона 1,5 ГиБ / 20 мин, `src/config.ts`); граница «крупного» ТЗ – 10K файлов |
| [mairamscpsl/parser-tekstov-osetinskogo-iazyka](https://sourcecraft.dev/mairamscpsl/parser-tekstov-osetinskogo-iazyka) | Python | 26.03.2026 | **N**/N | нет README – кейс «документация отсутствует» |
| [plusovichki/priplusnutaya-laba-1](https://sourcecraft.dev/plusovichki/priplusnutaya-laba-1) | C++ | 08.04.2026 | Y/N | студенческая лаба (10 файлов) – низ здоровья честный |
| [raph/its-wednesday-my-dudes](https://sourcecraft.dev/raph/its-wednesday-my-dudes) | – | 01.10.2025 | Y/N | мем-репо (README-only) – анти-паттерн «звездность ≠ здоровье» |

Крупнее живой выборки – синтетический стресс-репозиторий
`bun scripts/gen-stress-repo.ts` (по умолчанию 25 000 коммитов, 12 000 файлов,
блоб 100 МБ, ~50 файлов с TODO/FIXME – за границей ТЗ 9.2: 20 000 коммитов /
10 000 файлов / 500 МБ).

## Примечания (найдено при проверке)

- **CI-маркер:** `.sourcecraft/ci.yaml` – конфиг CI/CD платформы; рядом
  бывают branches.yaml / review.yaml / sites.yaml / security/. Детект CI =
  дерево файлов, механически: сборщик пишет полный список `.sourcecraft/**`,
  `has_ci_yaml` и `has_steps` (есть хотя бы один task с непустой командой;
  живые формы ci.yaml трех репо выборки лежат в `tests/fixtures/ci/`).
  В оценке (`src/score/compute.ts`, `scoreCicd`) конфиг без шагов или без
  ci.yaml = «CI нет» = 0, но только при видимых запусках; без доступа к
  запускам категория CI/CD – «нет данных» независимо от ci.yaml.
- **Зеркала:** репо вида «Synced from github.com/…» синкаются роботом
  (~каждые 2 часа); их «активность» – это синк-боты, не люди. У зеркал
  SC-CI обычно нет (CI живет на исходной платформе). Метрика активности это
  учитывает: `src/score/robot2.ts` помечает роботов по автору ([bot], -bot,
  dependabot/renovate/allcontributors, noreply-домены) и синк-всплески (10 и
  больше коммитов за 2 с по датам коммитера) и исключает их из частоты и
  свежести; «похожесть на зеркало» (`mirror_likeness`) показывается справочно,
  без веса.
- **AppSec:** `.sourcecraft/security/*.yaml` – конфиг-поверхность AppSec
  в самом репо (пример licenses.yaml – SCA-риски лицензий); сборщик эти файлы
  не читает. Живые результаты сканов берутся из официального AppSec API
  (`APPSEC_API_BASE`, по умолчанию appsec.sourcecraft.tech) только с Bearer PAT:
  `/v1/scans/latest` и `/v1/defect-groups` (`src/collectors/appsec.ts`);
  хранятся агрегаты по серьезности, доля закрытых и признак критичных секретов.
  401/403 – «нет данных: доступ», отсутствие или незавершенный скан – «нет данных».
- **Анонимный git:** git.sourcecraft.dev отдает публичные репо без токена
  (каталог и REST API без PAT отвечают 401/403 – для них нужен
  `SOURCECRAFT_TOKEN`; в фактах это «нет данных: доступ»). Крупные репо для
  нагрузочных тестов брать отсюда или генерировать `scripts/gen-stress-repo.ts`.
- TODO/FIXME-файлы есть у: uikit (27 файлов), testplane (25), manytask
  (34), kernel-hardening-checker (3), dozzle-plus (4) – идут в категорию Code:
  сборщик считает маркеры TODO/FIXME/HACK/XXX только первым словом комментария
  (`todoMarkerKind` в `src/collectors/git.ts`), оценка – плотность пометок на
  1000 строк кода (`TODO_PER_KLOC`).
