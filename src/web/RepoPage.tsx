// RepoPage.tsx — карточка репозитория (план §5): Score, шесть категорий
// с раскрытием submetrics, маркеры и рекомендации с доказательствами.
// Главное правило экрана — трекер-закон в UI: ни одной фразы без факта
// либо без честного объяснения, почему факта нет.
import { useState } from "react";
import { Alert, Button, Card, Disclosure, Flex, Label, Link, Loader, Progress, Text } from "@gravity-ui/uikit";
import type { CardCategory } from "../api/repos";
import type { MetaResponse, RepoCard } from "./api";
import { useJson } from "./api";
import {
  NO_DATA,
  NO_SCORE,
  SECURITY_PUBLIC_NOTE,
  fmtCoverage,
  fmtDate,
  fmtDateTime,
  fmtFactValue,
  fmtNumber,
  fmtScore,
  fmtSubmetric,
  scanStatusText,
} from "./format";
import { linkProps } from "./router";

type Card = RepoCard;
type Category = CardCategory;
type Evidence = Card["evidence"][number];
type Recommendation = Card["recommendations"][number];

export function RepoPage({ org, repo, meta, own = false }: { org: string; repo: string; meta: MetaResponse | null; own?: boolean }) {
  // own-режим (В4/Б5): карточка своего репо — 6 категорий, Security с
  // фактами AppSec, CI-раны; адрес отдельный, публичный скор не трогается
  const base = own ? `/api/me/repos` : `/api/repos`;
  const { state, reload } = useJson<Card>(`${base}/${encodeURIComponent(org)}/${encodeURIComponent(repo)}`);

  if (state.kind === "loading") {
    return (
      <Flex gap={2} alignItems="center">
        <Loader size="s" />
        <Text color="secondary">Загружаем карточку…</Text>
      </Flex>
    );
  }
  if (state.kind === "error") {
    return (
      <Alert
        theme={own ? "normal" : "danger"}
        title={own ? `Свой репозиторий ${org}/${repo} ещё не анализировался` : `Не удалось открыть ${org}/${repo}`}
        message={
          own
            ? "Own-оценка появляется после первого анализа из «Моего кабинета»: там же вход Я ID и окно PAT."
            : state.message
        }
        actions={own ? [] : [{ text: "Повторить", handler: reload }]}
      />
    );
  }

  const card = state.data;
  return (
    <Flex direction="column" gap={6}>
      <Header card={card} own={own} />
      {card.score === null ? (
        <Alert
          theme="normal"
          title="Репозиторий есть в каталоге, но ещё не сканировался"
          message="Score появится после первого скана: его считает код по фактам, а фактов пока нет."
        />
      ) : (
        <>
          <ScoreBlock card={card} meta={meta} />
          <Categories card={card} meta={meta} securityNote={own ? ownSecurityNote(card) : undefined} />
          <Markers card={card} />
          <Recommendations card={card} />
          {own ? (
            <Text color="secondary">
              MD-выгрузка — у публичной карточки ({`${org}/${repo}`}); own-оценка живёт в интерфейсе и API
              GET /api/me/repos/org/repo.
            </Text>
          ) : (
            <ReportLink org={org} repo={repo} />
          )}
        </>
      )}
    </Flex>
  );
}

/** Кнопка выгрузки: ссылка на тот же генератор, что рисует страницу (§2.3). */
function ReportLink({ org, repo }: { org: string; repo: string }) {
  const href = `/api/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}/report.md`;
  return (
    <Flex direction="column" gap={1} alignItems="flex-start">
      <Button view="action" size="l" href={href}>
        Скачать отчёт (MD)
      </Button>
      <Text color="secondary">
        Полный разбор: категории, подметрики, все рекомендации с фактами и раздел об ограничениях методики.
      </Text>
    </Flex>
  );
}

function Header({ card, own = false }: { card: Card; own?: boolean }) {
  const { repo: r, scan, score } = card;
  return (
    <Flex direction="column" gap={2}>
      <Flex gap={3} alignItems="baseline" wrap>
        <Text variant="header-2" as="h1">
          {r.org}/{r.repo}
        </Text>
        <Link href={r.webUrl} target="_blank" rel="noreferrer">
          открыть на sourcecraft.dev
        </Link>
      </Flex>
      {r.title && r.title !== r.repo && <Text color="secondary">{r.title}</Text>}
      <Flex gap={2} wrap alignItems="center">
        <Label theme="normal">язык: {r.language ?? "не определён"}</Label>
        <Label theme="normal">лайки: {fmtNumber(r.likes)}</Label>
        <Label theme="normal">форки: {fmtNumber(r.forks)}</Label>
        <Label theme="normal">последняя активность: {fmtDate(r.lastActivityAt)}</Label>
      </Flex>
      <Text color="secondary">
        {scan
          ? `Просканирован ${fmtDateTime(scan.finishedAt ?? scan.startedAt)}, скан #${scan.id} (${scanStatusText(scan.status)}, запуск: ${scan.trigger})`
          : "Скана ещё не было"}
        {score ? `, модель ${score.modelVersion}, режим ${own ? "свой репо (6 категорий)" : "публичный (4 категории)"}` : ""}
      </Text>
    </Flex>
  );
}

function ScoreBlock({ card, meta }: { card: Card; meta: MetaResponse | null }) {
  const score = card.score!;
  const threshold = meta ? fmtCoverage(meta.coverageNullBelow) : "порога";
  return (
    <Card view="outlined" style={{ padding: "var(--g-spacing-6)" }}>
      <Flex gap={6} alignItems="center" wrap>
        <Flex direction="column" gap={1} alignItems="center" style={{ minWidth: 160 }}>
          {score.totalRating === null ? (
            <Label theme="unknown" size="m">
              {NO_SCORE}
            </Label>
          ) : (
            <>
              <Text variant="display-3">{fmtScore(score.totalRating)}</Text>
              <Text color="secondary">из 100</Text>
            </>
          )}
        </Flex>
        <Flex direction="column" gap={2} style={{ flex: 1, minWidth: 320 }}>
          <Text>
            Покрытие данными — {fmtCoverage(score.coverageRating)}
            {meta ? ` (ниже ${threshold} Score не выставляется: без данных честного числа нет)` : ""}.
          </Text>
          <Progress value={Math.round(score.coverageRating * 100)} size="s" theme="info" />
          {score.noData.length > 0 && (
            <Flex direction="column" gap={1}>
              <Text color="secondary">Каких данных не хватило:</Text>
              {score.noData.map((raw) => (
                <Text key={raw} color="secondary">
                  • {humanNoData(raw)}
                </Text>
              ))}
            </Flex>
          )}
        </Flex>
      </Flex>
    </Card>
  );
}

function Categories({ card, meta, securityNote }: { card: Card; meta: MetaResponse | null; securityNote?: string }) {
  const score = card.score!;
  const entries = Object.entries(score.categories) as [string, Category][];
  // фактический вклад после перенормировки: вес категории делится на сумму
  // весов тех категорий, у которых данные есть (§4 методики)
  const dataWeight = entries.reduce((sum, [, cat]) => (cat.score === null ? sum : sum + cat.weight), 0);
  const titleOf = (key: string): string => meta?.categories.find((c) => c.key === key)?.title ?? key;

  return (
    <Flex direction="column" gap={3}>
      <Text variant="header-1" as="h2">
        Категории
      </Text>
      {entries.map(([key, cat]) => (
        <Card key={key} view="outlined" style={{ padding: "var(--g-spacing-5)" }}>
          <Flex direction="column" gap={3}>
            <Flex gap={4} alignItems="center" wrap>
              <Text variant="subheader-2" style={{ minWidth: 160 }}>
                {titleOf(key)}
              </Text>
              <div style={{ flex: 1, minWidth: 200 }}>
                {cat.score === null ? (
                  <Text color="secondary">{NO_DATA}</Text>
                ) : (
                  <Progress value={Math.round(cat.score)} size="s" theme="info" />
                )}
              </div>
              <Text variant="subheader-2" style={{ minWidth: 60, textAlign: "right" }}>
                {cat.score === null ? "—" : fmtScore(cat.score)}
              </Text>
              <Label theme="normal" title="номинальный вес категории в модели">
                вес {cat.weight}%
              </Label>
              <Label theme={cat.score === null ? "unknown" : "info"} title="вклад в итоговый Score после перенормировки">
                вклад {cat.score === null ? "0%" : `${Math.round((cat.weight / Math.max(1, dataWeight)) * 100)}%`}
              </Label>
              {cat.stale && <Label theme="warning">факты из истории</Label>}
            </Flex>

            {cat.score === null && (
              <Text color="secondary">
                {key === "security" && securityNote !== undefined
                  ? securityNote
                  : key === "security"
                    ? SECURITY_PUBLIC_NOTE
                    : humanNoData(`${key}: ${cat.no_data ?? ""}`)}{" "}
                Категория не снизила Score: её вес выброшен, остальные перенормированы.
              </Text>
            )}
            {cat.score !== null && cat.no_data && <Text color="secondary">{humanNoData(`${key}: ${cat.no_data}`)}</Text>}

            {Object.keys(cat.submetrics).length > 0 && (
              <Disclosure summary="Подметрики" size="m">
                <Flex direction="column" gap={2} style={{ paddingTop: "var(--g-spacing-2)" }}>
                  {Object.entries(cat.submetrics).map(([subKey, sub]) => (
                    <Flex key={subKey} gap={3} alignItems="baseline" wrap>
                      <Text style={{ minWidth: 220 }}>{submetricTitle(key, subKey)}</Text>
                      <Text color="secondary" style={{ minWidth: 90 }}>
                        {displayOnly(key, subKey)
                          ? "показ, без веса"
                          : sub.score === null
                            ? NO_DATA
                            : `${fmtSubmetric(sub.score)} / 100`}
                      </Text>
                      <Text color="secondary">значение: {fmtFactValue(sub.value)}</Text>
                      {sub.note && <Text color="secondary">({sub.note})</Text>}
                    </Flex>
                  ))}
                </Flex>
              </Disclosure>
            )}
          </Flex>
        </Card>
      ))}
    </Flex>
  );
}

function Markers({ card }: { card: Card }) {
  const m = card.markers;
  const rows: { key: string; label: string; text: string }[] = [];
  if (m.staleFacts) {
    rows.push({
      key: "stale",
      label: "факты из истории",
      text: "Часть источников ответила сбоем канала, поэтому в расчёт пошли последние успешные факты предыдущих сканов. Сбой трубы — не отсутствие данных, и он не превращается в премию или штраф.",
    });
  }
  if (m.historyTruncatedSince) {
    rows.push({
      key: "truncated",
      label: "история усечена",
      text: `Репозиторий слишком велик для полного клона, сработал деградационный ярус: git-история видна с ${fmtDate(m.historyTruncatedSince)}. Метрики активности и возраста TODO посчитаны по видимой части.`,
    });
  }
  if (m.ciConfigOnlyCap) {
    rows.push({
      key: "ci-cap",
      label: "CI заявлен, прогоны недоступны",
      text: "Конфигурация CI в репозитории есть, но статусы прогонов закрыты правами (403 для чужих репозиториев). Заявленный CI даёт максимум 50 из 100 — доказательства дают прогоны.",
    });
  }
  if (rows.length === 0) return null;

  return (
    <Flex direction="column" gap={3}>
      <Text variant="header-1" as="h2">
        Особенности расчёта
      </Text>
      {rows.map((row) => (
        <Card key={row.key} view="filled" style={{ padding: "var(--g-spacing-4)" }}>
          <Flex direction="column" gap={2} alignItems="flex-start">
            <Label theme="warning">{row.label}</Label>
            <Text color="secondary">{row.text}</Text>
          </Flex>
        </Card>
      ))}
    </Flex>
  );
}

function Recommendations({ card }: { card: Card }) {
  const evidence = new Map(card.evidence.map((e) => [e.key, e]));
  if (card.recommendations.length === 0) {
    return (
      <Flex direction="column" gap={2}>
        <Text variant="header-1" as="h2">
          Рекомендации
        </Text>
        <Text color="secondary">Правила движка не нашли, к чему придраться на текущих фактах.</Text>
      </Flex>
    );
  }
  return (
    <Flex direction="column" gap={3}>
      <Text variant="header-1" as="h2">
        Рекомендации ({card.recommendations.length})
      </Text>
      <Text color="secondary">
        Порядок задан движком правил: сперва измеримый прирост Score, затем то, что открывает закрытую категорию,
        затем улучшения по уже собранным данным. Каждая строка раскрывается в факт, из которого она получена.
      </Text>
      {card.recommendations.map((rec) => (
        <RecommendationCard key={rec.ruleId} rec={rec} evidence={evidence} />
      ))}
    </Flex>
  );
}

function RecommendationCard({ rec, evidence }: { rec: Recommendation; evidence: Map<string, Evidence> }) {
  const [openKey, setOpenKey] = useState<string | null>(null);
  return (
    <Card view="outlined" style={{ padding: "var(--g-spacing-5)" }}>
      <Flex direction="column" gap={2}>
        <Flex gap={3} alignItems="center" wrap>
          <Label theme="normal">#{rec.priority}</Label>
          <Text variant="subheader-2">{rec.problem}</Text>
          {rec.deltaScore !== null ? (
            <Label theme="success" title="прирост итогового Score, если выполнить только эту рекомендацию">
              +{fmtNumber(rec.deltaScore)} Score
            </Label>
          ) : rec.opensCategory ? (
            <Label theme="info" title="категория без данных станет считаемой">
              откроет категорию
            </Label>
          ) : null}
        </Flex>
        <Text>{rec.action}</Text>
        {rec.expectedImpact && <Text color="secondary">Эффект: {rec.expectedImpact}</Text>}
        <Flex gap={2} wrap alignItems="center">
          <Text color="secondary">основано на фактах:</Text>
          {rec.factRefs.map((ref) => (
            <Label
              key={ref.key}
              theme={ref.missing ? "unknown" : "info"}
              interactive
              onClick={() => setOpenKey(openKey === ref.key ? null : ref.key)}
            >
              {ref.key}
            </Label>
          ))}
        </Flex>
        {openKey !== null && <FactProof factKey={openKey} fact={evidence.get(openKey)} />}
      </Flex>
    </Card>
  );
}

/** Раскрытие чипа: значение факта либо объяснение, почему факта нет. */
function FactProof({ factKey, fact }: { factKey: string; fact: Evidence | undefined }) {
  if (!fact) {
    return (
      <Card view="filled" style={{ padding: "var(--g-spacing-4)" }}>
        <Flex direction="column" gap={1}>
          <Text variant="subheader-1">{factKey} — факта нет по построению</Text>
          <Text color="secondary">{SECURITY_PUBLIC_NOTE}</Text>
        </Flex>
      </Card>
    );
  }
  return (
    <Card view="filled" style={{ padding: "var(--g-spacing-4)" }}>
      <Flex direction="column" gap={1}>
        <Flex gap={2} wrap alignItems="center">
          <Text variant="subheader-1">{fact.key}</Text>
          <Label theme={fact.status === "ok" ? "success" : fact.status === "bad" ? "warning" : "unknown"}>
            {factStatusText(fact.status)}
          </Label>
          <Text color="secondary">
            источник {fact.source}, собрано {fmtDateTime(fact.collectedAt)}
          </Text>
        </Flex>
        <pre style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word", font: "var(--g-text-code-1-font)" }}>
          {fmtFactValue(fact.value)}
        </pre>
      </Flex>
    </Card>
  );
}

function factStatusText(status: string): string {
  switch (status) {
    case "ok":
      return "данные есть";
    case "no-data":
      return "данных нет";
    case "bad":
      return "сбой канала";
    default:
      return status;
  }
}

/**
 * Причины no-data движок пишет по-английски и кодами каналов — экран
 * переводит их в человеческую фразу, не теряя исходной строки смысла.
 */
export function humanNoData(raw: string): string {
  const [category = "", ...rest] = raw.split(":");
  const reason = rest.join(":").trim();
  const prefix = category === "security" ? "" : `${categoryWord(category)}: `;
  if (category === "security" || reason.startsWith("AppSec data unavailable")) return SECURITY_PUBLIC_NOTE;
  if (reason.startsWith("ci runs no-data")) {
    return `${prefix}прогоны CI недоступны (закрыты правами или их нет) — категория ограничена потолком 50.`;
  }
  if (reason === "git channel no-data") return `${prefix}git-канал не отдал данные (клон не удался или упёрся в лимиты).`;
  if (reason === "git+rest channels no-data") return `${prefix}ни git-, ни REST-канал не отдали данных.`;
  if (reason === "issues channel no-data") return `${prefix}данные трекера задач недоступны.`;
  return `${prefix}${reason || NO_DATA}`;
}

function categoryWord(key: string): string {
  const words: Record<string, string> = {
    documentation: "Документация",
    cicd: "CI/CD",
    security: "Security",
    activity: "Активность",
    issues: "Issues",
    code: "Code health",
  };
  return words[key] ?? key;
}

/** Показ-без-веса (§7.3 методики): число объясняет картину, но в Score не идёт. */
const DISPLAY_ONLY = new Set([
  "activity.mirror_likeness",
  "activity.commits_90d",
  "activity.commits_365d",
  "activity.sync_bursts",
  "code.todo_total",
]);

function displayOnly(category: string, sub: string): boolean {
  return DISPLAY_ONLY.has(`${category}.${sub}`);
}

const SUBMETRIC_TITLES: Record<string, string> = {
  "documentation.readme": "README (наличие и качество)",
  "documentation.license": "Лицензия",
  "documentation.contributing": "CONTRIBUTING",
  "documentation.codeowners": "CODEOWNERS",
  "cicd.config": "Конфигурация CI со шагами",
  "cicd.pass_rate": "Доля успешных прогонов",
  "cicd.duration": "Медианная длительность пайплайна",
  "security.density": "Плотность находок на 10К строк",
  "security.resolved": "Доля закрытых находок",
  "security.secrets": "Отсутствие критичных утечек",
  "activity.fresh": "Свежесть последнего коммита человека",
  "activity.freq": "Частота коммитов",
  "activity.contributors": "Число авторов",
  "activity.pulls_90d": "Merge-request'ы за 90 дней",
  "activity.releases_12m": "Релизы за 12 месяцев",
  "activity.mirror_likeness": "Похожесть на зеркало",
  "activity.commits_90d": "Коммиты за 90 дней",
  "activity.commits_365d": "Коммиты за год",
  "activity.sync_bursts": "Всплески синхронизации",
  "issues.stale": "Доля зависших issues",
  "issues.close_days": "Медиана времени закрытия",
  "issues.resolution": "Доля решённых",
  "issues.first_resp": "Время до первого ответа",
  "issues.tracker_unused": "Трекер не ведётся",
  "code.density": "Плотность TODO/FIXME",
  "code.old_share": "Доля старых TODO",
  "code.root": "Порядок в корне репозитория",
  "code.todo_total": "Всего маркеров TODO/FIXME",
};

function submetricTitle(category: string, sub: string): string {
  return SUBMETRIC_TITLES[`${category}.${sub}`] ?? sub;
}

/** Причина no-data Security в own-режиме — из факта appsec.findings (честный tri-state). */
function ownSecurityNote(card: Card): string {
  const fact = card.evidence.find((e) => e.key === "appsec.findings");
  const reason = fact && fact.status === "no-data" ? (fact.value as { reason?: string }).reason : undefined;
  if (reason === "access") {
    return "AppSec этого репозитория недоступен токену: право src.repositories.useAppSecScan не выдано. Это отсутствие данных, не ноль — вес категории выброшен.";
  }
  if (reason === "no-scan") {
    return "Завершённого скана AppSec нет (не запускался или идёт right now). Это отсутствие данных, не ноль.";
  }
  if (reason === "incomplete") {
    return "AppSec API ответил неполно (канал/пагинация). Ошибка — не отсутствие уязвимостей: вес категории выброшен до успешного пересбора.";
  }
  return "AppSec-данных нет: сохраните PAT в «Моем кабинете» — Security считается только с правами вашего токена.";
}
