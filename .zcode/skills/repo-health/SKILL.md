---
name: repo-health
description: Use when working in the SourceCraft Repo Health repository (ЛЦТ hackathon case 18 — LLM-assisted repository health scoring for SourceCraft). Covers project map, milestone discipline, the tracker law (code computes the score, LLM only explains), tri-state no-data semantics, SourceCraft API probing, Yandex Cloud deployment. Trigger words — repo health, SourceCraft, health score, ЛЦТ, кейс 18.
---

# repo-health — проектная карточка

- **Что это:** веб-сервис оценки здоровья открытых репозиториев
  SourceCraft: Repo Health Score 0–100 по 6 категориям, объяснимая
  формула, рекомендации с фактами, рейтинг, Я ID, периодический
  пересчёт, MD/PDF-отчёты. Хакатон ЛЦТ, окно 15–29.09, питч 23.10.
- **Карта:** CONTEXT.md (стек/файлы/конвенции), TASK.md (канва:
  решения + вехи В0–В6 + открытые вопросы), AGENTS.md (конституция:
  конвейер хакатон-веса, законы кода), ERROR_LOG.md, ТЗ = ../PDF +
  README.md, vendored OpenAPI = docs/api-spec/.
- **Стек:** Bun+TS strict, SQLite (bun:sqlite WAL, схема в src/db.ts),
  статические полки UI, LLM-шов src/llm.ts (YandexGPT основной /
  z.ai бэкап, роли MAIN/SIDE), стенд Yandex Cloud.
- **Прогресс:** В0 бутстрап+зонд DONE 15.09 (491a23b; tsc 0, 3/3);
  далее В1 коллекторы → В2 методика (критик-раунд) → В3 UI → В4
  Я ID+периодика → В5 звёздочка → В6 финал; КТ = 19–20.09.
- **Открытые блокеры (детали в TASK §4):** токен SourceCraft, Я ID
  приложение, YandexGPT ключ+folder, энумерация каталога (браузерный
  зонд), AppSec-поверхность (нет в публичном OpenAPI).
- **Законы:** трекер-закон (Score = код; LLM-текст с fact_ref и
  валидатором), tri-state NULL, код не храним, секреты в .env.
