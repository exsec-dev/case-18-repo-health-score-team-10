// RepoPage.tsx — единая карточка репозитория (план §5 В3 + К2 В4.1):
// Score в рейтинге и полный Score, шесть категорий с раскрытием
// submetrics, маркеры и рекомендации с доказательствами. Состав ответа
// собирает сервер по доступу зрителя: закрытые ему блоки CI/Security
// приходят без чисел и показываются заглушкой по причине доступа.
// Главное правило экрана — трекер-закон в UI: ни одной фразы без факта
// либо без честного объяснения, почему факта нет.
import { useEffect, useState } from "react";
import { Alert, Button, Card, Disclosure, Flex, Label, Link, Loader, Progress, Text } from "@gravity-ui/uikit";
import type { CardCategory } from "../api/repos";
import type { MeResponse, MetaResponse, RepoCard } from "./api";
import { fetchJson, mutateJson, useJson } from "./api";
import {
  NO_DATA,
  NO_SCORE,
  SECURITY_PUBLIC_NOTE,
  accessLockText,
  fmtCoverage,
  fmtDate,
  fmtDateTime,
  fmtFactValue,
  fmtNumber,
  fmtScore,
  fmtSubmetric,
  gitLimitsText,
  scanStatusText,
} from "./format";
import { linkProps } from "./router";

type Card = RepoCard;
type Category = CardCategory;
type Evidence = Card["evidence"][number];
type Recommendation = Card["recommendations"][number];

export function RepoPage({ org, repo, meta }: { org: string; repo: string; meta: MetaResponse | null }) {
  const cardUrl = `/api/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}`;
  const { state, reload } = useJson<Card>(cardUrl);
  const me = useJson<MeResponse>("/api/me");
  const canRefresh = me.state.kind === "ok" && me.state.data.login !== null && me.state.data.hasPat;

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
      <Flex direction="column" gap={4}>
        <Alert theme="danger" title={`Не удалось открыть ${org}/${repo}`} message={state.message} actions={[{ text: "Повторить", handler: reload }]} />
        {canRefresh && <RefreshAnalysis org={org} repo={repo} cardUrl={cardUrl} sinceScanId={0} onDone={reload} />}
      </Flex>
    );
  }

  const card = state.data;
  return (
    <Flex direction="column" gap={6}>
      <Header card={card} />
      {canRefresh && <RefreshAnalysis org={org} repo={repo} cardUrl={cardUrl} sinceScanId={card.scan?.id ?? 0} onDone={reload} />}
      {card.score === null ? (
        <Alert
          theme="normal"
          title="Репозиторий есть в каталоге, но ещё не сканировался"
          message="Score появится после первого скана: его считает код по фактам, а фактов пока нет."
        />
      ) : (
        <>
          <ScoreBlock card={card} meta={meta} />
          <Categories card={card} meta={meta} />
          <Markers card={card} />
          <Recommendations card={card} />
          <ReportLink org={org} repo={repo} />
        </>
      )}
    </Flex>
  );
}

/**
 * «Обновить анализ» — зрителю с сессией и PAT (К2). Сервер проверяет доступ
 * PAT до постановки (К3); ответ показывается как есть, опрос карточки — до
 * появления нового завершённого скана.
 */
function RefreshAnalysis({ org, repo, cardUrl, sinceScanId, onDone }: { org: string; repo: string; cardUrl: string; sinceScanId: number; onDone: () => void }) {
  const [phase, setPhase] = useState<"idle" | "sending" | "queued">("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (phase !== "queued") return;
    const started = Date.now();
    const timer = setInterval(async () => {
      if (Date.now() - started > 60 * 60_000) {
        setPhase("idle");
        return;
      }
      try {
        const card = await fetchJson<Card>(cardUrl);
        if (card.scan && card.scan.id > sinceScanId && card.scan.finishedAt && card.scan.status !== "running") {
          setPhase("idle");
          onDone();
        }
      } catch {
        /* карточки ещё нет — следующий тик */
      }
    }, 5000);
    return () => clearInterval(timer);
  }, [phase, cardUrl, sinceScanId, onDone]);

  async function start() {
    setPhase("sending");
    setError(null);
    try {
      await mutateJson(`/api/me/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}/scan`, "POST");
      setPhase("queued");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("idle");
    }
  }

  return (
    <Flex direction="column" gap={2} alignItems="flex-start">
      <Flex gap={3} alignItems="center" wrap>
        <Button view="outlined" size="m" onClick={start} loading={phase === "sending"} disabled={phase !== "idle"}>
          Обновить анализ
        </Button>
        {phase === "queued" && <Label theme="info">анализ в очереди — карточка обновится после скана</Label>}
      </Flex>
      {error && <Alert theme="danger" title="Анализ не запущен" message={error} />}
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

function Header({ card }: { card: Card }) {
  const { repo: r, scan, score } = card;
  return (
    <Flex direction="column" gap={2}>
      <Flex gap={3} alignItems="baseline" wrap>
        <Text variant="header-2" as="h1">
          {r.org}/{r.repo}
        </Text>
        <FavoriteStar org={r.org} repo={r.repo} />
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
        {score ? `, модель ${score.modelVersion}` : ""}
      </Text>
    </Flex>
  );
}

/** Причина закрытия полного итога: первый закрытый канал (CI, затем Security). */
function fullLockReason(card: Card): string | null {
  return accessLockText(card.access.cicd) ?? accessLockText(card.access.appsec);
}

function ScoreBlock({ card, meta }: { card: Card; meta: MetaResponse | null }) {
  const score = card.score!;
  const threshold = meta ? fmtCoverage(meta.coverageNullBelow) : "порога";
  return (
    <Card view="outlined" style={{ padding: "var(--g-spacing-6)" }}>
      <Flex direction="column" gap={4}>
        <Flex gap={6} alignItems="flex-start" wrap>
          <ScoreTile title="Score в рейтинге (4 категории)" total={score.totalRating} coverage={score.coverageRating} />
          {score.fullLocked ? (
            <Flex direction="column" gap={1} style={{ minWidth: 220, maxWidth: 360 }}>
              <Text color="secondary">Полный Score (с CI и Security)</Text>
              <Label theme="unknown" size="m">
                закрыто
              </Label>
              <Text color="secondary">{fullLockReason(card)}</Text>
            </Flex>
          ) : (
            <ScoreTile title="Полный Score (с CI и Security)" total={score.totalFull} coverage={score.coverageFull ?? 0} />
          )}
        </Flex>
        <Text color="secondary">
          {meta ? `При покрытии данными ниже ${threshold} Score не выставляется: без данных честного числа нет. ` : ""}В рейтинге
          сравниваются только 4 категории; CI и Security видны участникам репозитория с доступом к этим данным.
        </Text>
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
    </Card>
  );
}

function ScoreTile({ title, total, coverage }: { title: string; total: number | null; coverage: number }) {
  return (
    <Flex direction="column" gap={1} style={{ minWidth: 220 }}>
      <Text color="secondary">{title}</Text>
      {total === null ? (
        <Label theme="unknown" size="m">
          {NO_SCORE}
        </Label>
      ) : (
        <Flex gap={2} alignItems="baseline">
          <Text variant="display-3">{fmtScore(total)}</Text>
          <Text color="secondary">из 100</Text>
        </Flex>
      )}
      <Text color="secondary">покрытие данными — {fmtCoverage(coverage)}</Text>
      <Progress value={Math.round(coverage * 100)} size="s" theme="info" />
    </Flex>
  );
}

function Categories({ card, meta }: { card: Card; meta: MetaResponse | null }) {
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
                {cat.locked !== undefined ? (
                  <Text color="secondary">закрыто</Text>
                ) : cat.score === null ? (
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

            {cat.locked !== undefined && <Text color="secondary">{accessLockText(cat.locked)}</Text>}
            {cat.locked === undefined && cat.score === null && (
              <Text color="secondary">
                {key === "security" ? securityNote(card) : humanNoData(`${key}: ${cat.no_data ?? ""}`)}{" "}
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
  if (m.gitLimits) {
    rows.push({ key: "git-limits", label: "репозиторий больше лимита сервиса", text: gitLimitsText(m.gitLimits) });
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

/** Причина no-data Security при открытом канале — из факта appsec.findings (честный tri-state). */
function securityNote(card: Card): string {
  const fact = card.evidence.find((e) => e.key === "appsec.findings");
  const reason = fact && fact.status === "no-data" ? (fact.value as { reason?: string }).reason : undefined;
  if (reason === "access") {
    return "AppSec этого репозитория недоступен токену скана: право src.repositories.useAppSecScan не выдано. Это отсутствие данных, не ноль — вес категории выброшен.";
  }
  if (reason === "no-scan") {
    return "Завершённого скана AppSec нет (не запускался или ещё идёт). Это отсутствие данных, не ноль.";
  }
  if (reason === "incomplete") {
    return "AppSec API ответил неполно (канал/пагинация). Ошибка — не отсутствие уязвимостей: вес категории выброшен до успешного пересбора.";
  }
  return SECURITY_PUBLIC_NOTE;
}


// ========== ПОРТ 6 (hq-parallel): избранное на карточке + локализация ==========

function triggerText(trigger: string): string {
  if (trigger === "user") return "вручную";
  if (trigger === "periodic") return "по расписанию";
  if (trigger === "probe") return "зонд";
  return trigger;
}

function FavoriteStar({ org, repo }: { org: string; repo: string }) {
  const [state, setState] = useState<"loading" | "on" | "off" | "anon">("loading");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let stop = false;
    fetch(`/api/me/favorites/${encodeURIComponent(org)}/${encodeURIComponent(repo)}`)
      .then(async (res) => {
        if (res.status === 401) {
          if (!stop) setState("anon");
          return;
        }
        const body = (await res.json()) as { favorite: boolean };
        if (!stop) setState(body.favorite ? "on" : "off");
      })
      .catch(() => {
        if (!stop) setState("anon");
      });
    return () => {
      stop = true;
    };
  }, [org, repo]);
  if (state === "loading") return null;
  const toggle = async () => {
    setError(null);
    if (state === "anon") return; // задизейблена: подсказка в title
    const next = state === "on" ? "off" : "on";
    setState(next);
    try {
      await mutateJson(`/api/me/favorites/${encodeURIComponent(org)}/${encodeURIComponent(repo)}`, next === "on" ? "PUT" : "DELETE");
    } catch (e) {
      setState(state); // откат — звезда не врёт
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <Flex direction="column" gap={1}>
      <Button
        size="m"
        view="flat"
        disabled={state === "anon"}
        title={state === "anon" ? "Войдите через Я ID, чтобы добавлять в избранное" : "в избранное: права проверятся в кабинете"}
        onClick={() => void toggle()}
      >
        {state === "on" ? "★" : "☆"}
      </Button>
      {error && <Text color="danger">{error}</Text>}
    </Flex>
  );
}
