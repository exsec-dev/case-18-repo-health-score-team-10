// compare.ts — сравнение 2-3 репозиториев (К-1 / К5.15, В5.3 круг 4).
//
// Решения — TASK.md §2 «В5.3, круг 4 — сравнение: …» (25.09): сравнивается
// любой репозиторий, чью карточку зритель может открыть (А2), — поэтому ответ
// собирается ТЕМ ЖЕ сборщиком, что карточка (`resolveCardForViewer`), с теми
// же гейтами прав, и своих гейтов у сравнения нет. Недоступный репозиторий —
// элемент `unavailable` без единого поля, кроме эха ввода: чужой приватный,
// internal без токена, выселенный публичный и несуществующий неотличимы.
//
// Отступление от контракта продуктового отчета §4.4 (названо в журнале плана):
// элемент несет не отдельную проекцию, а карточку зрителя без AI, рекомендаций,
// фактов, производных и живой заявки. Тексты значений, причин и поправок веб
// строит теми же функциями, что карточка, — одна копия, и тест «равно
// источнику» сводится к сравнению с карточкой того же зрителя.
import { MODEL_VERSION } from "../score/model";
import type { CardOutcome, RepoCard } from "./repos";
import { slugSegmentOk } from "./slug-input";

/** Больше 3 — это уже рейтинг, а не сравнение (решение 25.09, В1). */
export const COMPARE_MAX = 3;

/** Карточка в сравнении: без того, что сравнению не показывается (AI, рекомендации, факты). */
export type CompareCard = Omit<RepoCard, "ai" | "recommendations" | "evidence" | "derived" | "job"> & {
  recommendations: [];
  evidence: [];
  derived: null;
  job: null;
};

export type CompareItem =
  | { slug: string; status: "unavailable" }
  | { slug: string; status: "check_failed" | "token_rejected" }
  | { slug: string; status: "ok"; card: CompareCard };

export interface CompareResponse {
  /** нормализованный запрос: дубли схлопнуты, порядок — первого вхождения, регистр — как ввел зритель */
  slugs: string[];
  /** в порядке `slugs` */
  items: CompareItem[];
  /** одна на ответ: строки других версий сборщик карточки не читает */
  modelVersion: string;
  generatedAt: string;
}

export type CompareQuery = { ok: true; slugs: { org: string; repo: string; slug: string }[] } | { ok: false; message: string };

/** `?r=org/repo&r=…` → 1-3 уникальных слага; иначе причина для 400. */
export function parseCompareQuery(params: URLSearchParams): CompareQuery {
  const raw = params.getAll("r");
  if (raw.length === 0) return { ok: false, message: "не указаны репозитории: нужен параметр r=org/repo" };
  const seen = new Set<string>();
  const slugs: { org: string; repo: string; slug: string }[] = [];
  for (const value of raw) {
    const parts = value.split("/");
    if (parts.length !== 2 || !slugSegmentOk(parts[0]) || !slugSegmentOk(parts[1])) {
      return { ok: false, message: "адрес репозитория указан неверно: нужен вид org/repo из латинских букв, цифр, точек, дефисов и подчеркиваний" };
    }
    if (seen.has(value)) continue;
    seen.add(value);
    slugs.push({ org: parts[0]!, repo: parts[1]!, slug: value });
  }
  if (slugs.length > COMPARE_MAX) return { ok: false, message: `сравнить можно не больше ${COMPARE_MAX} репозиториев` };
  return { ok: true, slugs };
}

/** Карточка → карточка сравнения: то, что сравнению не показывается, не едет в ответ вовсе. */
export function compareCardOf(card: RepoCard): CompareCard {
  // В5.9: лестница — гипотетический план карточки, не данные репозитория; в сравнение не едет
  const { ai: _ai, recommendations: _r, evidence: _e, derived: _d, job: _j, ladder: _l, ...rest } = card;
  return { ...rest, recommendations: [], evidence: [], derived: null, job: null };
}

/** Исход показа карточки → элемент сравнения (статусы — ровно как у карточки, К8.5.6). */
export function compareItemOf(slug: string, out: CardOutcome): CompareItem {
  if (out.kind === "card") return { slug, status: "ok", card: compareCardOf(out.card) };
  if (out.kind === "check_failed" || out.kind === "token_rejected") return { slug, status: out.kind };
  return { slug, status: "unavailable" };
}

/**
 * Сборка ответа: исходы карточек — параллельно (не больше 3; склейка
 * одинаковых проверок прав и их кэш — в `access.ts`).
 */
export async function buildCompare(
  slugs: { org: string; repo: string; slug: string }[],
  resolveOne: (org: string, repo: string) => Promise<CardOutcome>,
  now: Date = new Date(),
): Promise<CompareResponse> {
  const outcomes = await Promise.all(slugs.map((s) => resolveOne(s.org, s.repo)));
  return {
    slugs: slugs.map((s) => s.slug),
    items: slugs.map((s, i) => compareItemOf(s.slug, outcomes[i]!)),
    modelVersion: MODEL_VERSION,
    generatedAt: now.toISOString(),
  };
}
