// MePage.tsx — «Мой кабинет» (В4/Б5): слои идентичности (Q4) — вход
// Я ID (UX), PAT SourceCraft (права на данные). Секции: PAT-окно
// github-style (вставка → живая проверка → зашифрованное хранение,
// замена/удаление), «мои репозитории» (PAT + ручной ввод слага —
// спискового юзерского эндпоинта в доках нет), запуск анализа с
// очередью и опросом статуса. Секция «Бюджеты скана» удалена (К5 В4.1,
// PENDING Алексей): лимиты скана — только оператор. Ссылки ведут на
// единую карточку /repo/... Токен НИКОГДА не возвращается API и не логируется.
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Button, Card, Flex, Label, Link, Loader, Text, TextInput } from "@gravity-ui/uikit";
import {
  MeResponse,
  MyReposResponse,
  RepoCard,
  fetchJson,
  mutateJson,
  useJson,
  type AsyncState,
} from "./api";
import { fmtDateTime, fmtScore } from "./format";
import { linkProps, repoHref } from "./router";

const SLUG_RE = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i;

type ScanJobState = { sinceScanId: number; startedAt: number; seenScanId: number | null; phase: "queued" | "running" };

export function MePage() {
  const me = useJson<MeResponse>("/api/me");

  if (me.state.kind === "loading") {
    return (
      <Flex gap={2} alignItems="center">
        <Loader size="s" />
        <Text color="secondary">Проверяем сессию…</Text>
      </Flex>
    );
  }
  if (me.state.kind === "error") {
    return <LoginOffer />;
  }
  const data = me.state.data;
  if (data.login === null) {
    return <LoginOffer />;
  }
  return (
    <Flex direction="column" gap={6}>
      <Flex direction="column" gap={1}>
        <Text variant="header-2" as="h1">
          Мой кабинет
        </Text>
        <Text color="secondary">
          Вы вошли как <Text variant="code-1">{data.login}</Text> (Я ID). Вход — это UX-слой; права на данные
          даёт отдельный PAT SourceCraft, как на любом git-хостинге.
        </Text>
      </Flex>
      <PatSection key={data.patCheckedAt ?? "no-pat"} hasPat={data.hasPat} checkedAt={data.patCheckedAt} onChanged={() => void me.reload()} />
      <CabinetJobs />
      {data.hasPat && <MyReposSection />}
    </Flex>
  );
}

/** Не вошедшему — объяснение слоёв и кнопка входа (живой клик — приёмка HQ). */
function LoginOffer() {
  return (
    <Card view="outlined" style={{ padding: "var(--g-spacing-6)" }}>
      <Flex direction="column" gap={4} alignItems="flex-start">
        <Text variant="header-2" as="h1">
          Анализ своего репозитория
        </Text>
        <Text color="secondary">
          Сценарий «свой репо» состоит из двух слоёв: вход через Я ID (кто вы у нас) и персональный токен
          SourceCraft (что платформа может вам показать — CI-раны и AppSec вашего репозитория). Токен создаётся
          в SourceCraft: Домой → Доступ → Персональные токены доступа.
        </Text>
        <Button view="action" size="l" href="/auth/ya">
          Войти через Я ID
        </Button>
        <Text color="secondary">
          Публичный рейтинг работает и без входа — ссылка «Рейтинг» в шапке. Блоки CI/CD и Security на карточке
          репозитория видны только тем, у кого есть к ним доступ на SourceCraft; в общий рейтинг они не
          вкладываются (требование организаторов).
        </Text>
      </Flex>
    </Card>
  );
}

// ---------- PAT-окно (github-style: PUT проверяет живьём, DELETE убирает) ----------

function PatSection({ hasPat, checkedAt, onChanged }: { hasPat: boolean; checkedAt: string | null; onChanged: () => void }) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [owner, setOwner] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const res = await mutateJson<{ ok: boolean; tokenOwner: string | null }>("/api/me/pat", "PUT", { token });
      setOwner(res.tokenOwner);
      setToken("");
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await mutateJson("/api/me/pat", "DELETE");
      setOwner(null);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card view="outlined" style={{ padding: "var(--g-spacing-5)" }}>
      <Flex direction="column" gap={3}>
        <Flex gap={3} alignItems="center" wrap>
          <Text variant="subheader-2">Токен SourceCraft (PAT)</Text>
          {hasPat ? (
            <Label theme="success">сохранён (проверен {fmtDateTime(checkedAt)})</Label>
          ) : (
            <Label theme="warning">не задан — свои репозитории недоступны</Label>
          )}
        </Flex>
        {hasPat ? (
          <Flex direction="column" gap={2} alignItems="flex-start">
            {owner && <Text color="secondary">Токен принадлежит пользователю {owner}.</Text>}
            <Text color="secondary">
              Токен хранится зашифрованным (AES-256-GCM) и никогда не возвращается обратно в браузер и не
              попадает в логи. Замена и удаление — сразу действуют на новые сканы.
            </Text>
            <Flex gap={2} wrap>
              <Button view="outlined" size="m" onClick={remove} loading={busy} disabled={busy}>
                Удалить токен
              </Button>
            </Flex>
            <Flex gap={2} wrap alignItems="flex-end">
              <TextInput
                type="password"
                label="Заменить токен"
                placeholder="вставьте новый PAT"
                value={token}
                onUpdate={setToken}
                hasClear
                size="m"
                style={{ maxWidth: 360 }}
              />
              <Button view="action" size="m" onClick={save} loading={busy} disabled={busy || token.length < 8}>
                Проверить и заменить
              </Button>
            </Flex>
          </Flex>
        ) : (
          <Flex direction="column" gap={2}>
            <Text color="secondary">
              SourceCraft: Домой → Доступ → Персональные токены доступа → Сгенерировать новый токен. Токен
              показывается один раз — скопируйте его сразу. Перед сохранением мы проверяем его живым запросом
              GET /user: неверный токен платформа отклонит, и он не сохранится.
            </Text>
            <Flex gap={2} wrap alignItems="flex-end">
              <TextInput
                type="password"
                label="Персональный токен"
                placeholder="SourceCraft PAT"
                value={token}
                onUpdate={setToken}
                hasClear
                size="m"
                style={{ maxWidth: 360 }}
              />
              <Button view="action" size="m" onClick={save} loading={busy} disabled={busy || token.length < 8}>
                Проверить и сохранить
              </Button>
            </Flex>
          </Flex>
        )}
        {error && <Alert theme="danger" title="Токен не сохранён" message={error} />}
      </Flex>
    </Card>
  );
}

// ---------- мои репозитории: список + ручной слаг + запуск анализа ----------

function MyReposSection() {
  const repos = useJson<MyReposResponse>("/api/me/repos");
  const [jobs, setJobs] = useState<Record<string, ScanJobState>>({});
  const [manualSlug, setManualSlug] = useState("");
  const [error, setError] = useState<string | null>(null);
  const reposReloadRef = useRef(repos.reload);
  reposReloadRef.current = repos.reload;

  const startScan = useCallback(async (slug: string) => {
    setError(null);
    try {
      // отсчёт: последний видимый скан, чтобы поймать появление нового
      let since = 0;
      try {
        const [org, repo] = slug.split("/");
        const card = await fetchJson<RepoCard>(`/api/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}`);
        since = card.scan?.id ?? 0;
      } catch {
        /* карточки может ещё не быть — значит since = 0 */
      }
      await mutateJson(`/api/me/repos/${slug.split("/").map(encodeURIComponent).join("/")}/scan`, "POST");
      setJobs((prev) => ({ ...prev, [slug]: { sinceScanId: since, startedAt: Date.now(), seenScanId: null, phase: "queued" } }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  // опрос статуса запущенных анализов: 3с, до 20 минут
  useEffect(() => {
    const slugs = Object.keys(jobs);
    if (slugs.length === 0) return;
    const timer = setInterval(async () => {
      for (const slug of slugs) {
        const job = jobs[slug]!;
        if (Date.now() - job.startedAt > 20 * 60_000) {
          setJobs((prev) => {
            const next = { ...prev };
            delete next[slug];
            return next;
          });
          continue;
        }
        try {
          const [org, repo] = slug.split("/");
          const card = await fetchJson<RepoCard>(`/api/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}`);
          if (card.scan && card.scan.id > job.sinceScanId) {
            if (card.scan.finishedAt && card.scan.status !== "running") {
              setJobs((prev) => {
                const next = { ...prev };
                delete next[slug];
                return next;
              });
              reposReloadRef.current();
            } else {
              setJobs((prev) => ({ ...prev, [slug]: { ...job, seenScanId: card.scan!.id, phase: "running" } }));
            }
          }
        } catch {
          /* карточка ещё не готова — следующий тик */
        }
      }
    }, 3000);
    return () => clearInterval(timer);
  }, [jobs]);

  return (
    <Card view="outlined" style={{ padding: "var(--g-spacing-5)" }}>
      <Flex direction="column" gap={4}>
        <Flex direction="column" gap={1}>
          <Text variant="subheader-2">Мои репозитории</Text>
          <Text color="secondary">
            Список читается из вашего namespace на SourceCraft по токену. Свои репозитории можно добавить и
            вручную — полем ниже: чужие и недоступные платформа сама не покажет.
          </Text>
        </Flex>

        {repos.state.kind === "loading" && (
          <Flex gap={2} alignItems="center">
            <Loader size="s" />
            <Text color="secondary">Читаем namespace по токену…</Text>
          </Flex>
        )}
        {repos.state.kind === "error" && <Alert theme="warning" title="Список не получился" message={repos.state.message} />}
        {repos.state.kind === "ok" && repos.state.data.entries.length === 0 && (
          <Text color="secondary">
            В namespace <Text variant="code-1">{repos.state.data.username}</Text> публичных репозиториев нет —
            добавьте свой слагом ниже.
          </Text>
        )}
        {repos.state.kind === "ok" &&
          repos.state.data.entries.map((entry) => {
            const job = jobs[`${entry.org}/${entry.repo}`];
            return (
              <RepoRow
                key={`${entry.org}/${entry.repo}`}
                org={entry.org}
                repo={entry.repo}
                title={entry.title}
                language={entry.language}
                lastActivityAt={entry.lastActivityAt}
                score={entry.score}
                lastScanAt={entry.lastScanAt}
                job={job ?? null}
                onScan={() => void startScan(`${entry.org}/${entry.repo}`)}
              />
            );
          })}

        <Flex gap={2} wrap alignItems="flex-end">
          <TextInput
            label="Добавить репозиторий"
            placeholder="org/repo"
            value={manualSlug}
            onUpdate={(v) => setManualSlug(v.trim())}
            hasClear
            size="m"
            style={{ maxWidth: 280 }}
            errorPlacement="inside"
            errorMessage={manualSlug !== "" && !SLUG_RE.test(manualSlug) ? "формат: org/repo" : undefined}
          />
          <Button
            view="outlined"
            size="m"
            disabled={!SLUG_RE.test(manualSlug)}
            onClick={() => {
              void startScan(manualSlug);
              setManualSlug("");
            }}
          >
            Запустить анализ
          </Button>
        </Flex>
        {error && <Alert theme="danger" title="Анализ не запущен" message={error} />}
      </Flex>
    </Card>
  );
}

function RepoRow(props: {
  org: string;
  repo: string;
  title: string | null;
  language: string | null;
  lastActivityAt: string | null;
  score: number | null;
  lastScanAt: string | null;
  job: ScanJobState | null;
  onScan: () => void;
}) {
  const { org, repo, job } = props;
  return (
    <Flex gap={4} alignItems="center" wrap style={{ borderTop: "1px solid var(--g-color-line-generic)", paddingTop: "var(--g-spacing-3)" }}>
      <Flex direction="column" gap={1} style={{ minWidth: 220, flex: 1 }}>
        <Link {...linkProps(repoHref(org, repo))}>
          {org}/{repo}
        </Link>
        <Text color="secondary">
          {props.title && props.title !== repo ? `${props.title} · ` : ""}
          {props.language ?? "язык не определён"}
          {props.lastActivityAt ? ` · активность ${fmtDateTime(props.lastActivityAt)}` : ""}
        </Text>
      </Flex>
      {job ? (
        <Label theme="info">{job.phase === "queued" ? "в очереди…" : "сканируется…"}</Label>
      ) : props.score !== null ? (
        <Flex gap={2} alignItems="center">
          <Text variant="subheader-2">{fmtScore(props.score)}</Text>
          <Text color="secondary">/ 100 в рейтинге{props.lastScanAt ? ` · ${fmtDateTime(props.lastScanAt)}` : ""}</Text>
        </Flex>
      ) : (
        <Label theme="unknown">ещё не анализировали</Label>
      )}
      <Button size="m" view={props.score !== null ? "outlined" : "action"} onClick={props.onScan} disabled={job !== null}>
        {props.score !== null ? "Обновить анализ" : "Анализировать"}
      </Button>
    </Flex>
  );
}

/** Заголовок шапки: логин/вход (App.tsx использует для чипа). */
export function useMe(): AsyncState<MeResponse> {
  const { state } = useJson<MeResponse>("/api/me");
  return state;
}


// ========== ПОРТ 5 (hq-parallel): панель заданий + избранное ==========

interface JobsResponse {
  active: import("../api/me").MyJob[];
  recent: import("../api/me").MyJob[];
}

/** Опрос /api/me/jobs: чаще при активных (честная позиция вместо спиннера);
 *  бэкофф ×2 до 5 мин на сбоях/401 после успешных данных — истёкшая сессия
 *  не крутит вечный 20-секундный опрос (ищейка-7). */
function useMyJobs(idleMs = 5000): { jobs: JobsResponse | null; reload: () => void } {
  const [jobs, setJobs] = useState<JobsResponse | null>(null);
  const [tick, setTick] = useState(0);
  const hadData = useRef(false);
  const reload = useCallback(() => setTick((x) => x + 1), []);
  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    let backoff = 1;
    const poll = async () => {
      let delay = idleMs;
      try {
        const res = await fetch("/api/me/jobs");
        if (res.status === 401 && hadData.current) {
          delay = Math.min(idleMs * backoff, 5 * 60_000);
          backoff = Math.min(backoff * 2, 60);
        } else if (res.ok) {
          const data = (await res.json()) as JobsResponse;
          if (!stop) {
            setJobs(data);
            hadData.current = true;
            backoff = 1;
            if (data.active.length > 0) delay = 3000;
          }
        }
      } catch {
        /* сеть — тихо */
      }
      if (!stop) timer = setTimeout(poll, delay);
    };
    void poll();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [tick, idleMs]);
  return { jobs, reload };
}

function jobPhaseLabel(j: import("../api/me").MyJob): string {
  if (j.phase === "queued") return j.queueAhead !== null && j.queueAhead > 0 ? `в очереди (${j.queueAhead + 1}-й) · перед вами ${j.queueAhead} скан(ов)` : "следующая в очереди";
  if (j.phase === "running") return "сканируется…";
  if (j.phase === "failed") return "ошибка";
  if (j.phase === "refused") return "отклонена (лимит заявок)";
  return "готово";
}

/** Колокольчик шапки: тихий в покое; «Задания ◷ N» с позициями; ⚠ с причиной. */
export function JobsBell() {
  const { jobs } = useMyJobs(20000);
  const active = jobs?.active ?? [];
  const failed = jobs?.recent.filter((j) => j.phase === "failed").length ?? 0;
  if (active.length === 0 && failed === 0 && jobs !== null) return null;
  return (
    <details style={{ position: "relative" }}>
      <summary style={{ cursor: "pointer", listStyle: "none", whiteSpace: "nowrap" }} title="ваши анализы в очереди">
        <Label theme={active.length > 0 ? "info" : "danger"}>Задания {active.length > 0 ? `◷ ${active.length}` : `⚠ ${failed}`}</Label>
      </summary>
      <Card view="outlined" style={{ position: "absolute", right: 0, top: "100%", zIndex: 10, marginTop: "var(--g-spacing-2)", minWidth: 360, padding: "var(--g-spacing-4)" }}>
        <Flex direction="column" gap={2}>
          <Text variant="subheader-3">Ваши задания</Text>
          {active.map((j) => (
            <Text key={j.jobId} color="secondary">
              <Text variant="code-1">{j.slug}</Text> — {jobPhaseLabel(j)}
            </Text>
          ))}
          {active.length === 0 && <Text color="secondary">активных нет; последняя ошибка ниже</Text>}
          {jobs?.recent
            .filter((j) => j.phase === "failed")
            .slice(0, 1)
            .map((j) => (
              <Text key={j.jobId} color="danger">
                <Text variant="code-1">{j.slug}</Text> — {j.error ?? "ошибка"}
              </Text>
            ))}
          <Link {...linkProps("/me")}>весь список — в кабинете</Link>
        </Flex>
      </Card>
    </details>
  );
}

/** Панель «Мои задания» кабинета: активные с позицией + последние с исходом. */
function JobsPanel(props: { jobs: JobsResponse | null; reload: () => void }) {
  const { jobs, reload } = props;
  if (jobs === null) return null;
  const { active, recent } = jobs;
  if (active.length === 0 && recent.length === 0) return null;
  return (
    <Card view="outlined" style={{ padding: "var(--g-spacing-5)" }}>
      <Flex direction="column" gap={3}>
        <Flex direction="column" gap={1}>
          <Text variant="subheader-2">Мои задания</Text>
          <Text color="secondary">Интерактивная очередь отдельная от ночной волны рейтинга — ваши сканы не ждут чужих клонов.</Text>
        </Flex>
        {active.map((j) => (
          <Flex key={j.jobId} gap={3} alignItems="center" wrap>
            <Label theme={j.phase === "running" ? "info" : "unknown"}>{jobPhaseLabel(j)}</Label>
            <Text>
              <Text variant="code-1">{j.slug}</Text>
            </Text>
          </Flex>
        ))}
        {recent.length > 0 && (
          <Flex direction="column" gap={2}>
            <Text variant="subheader-3">Последние</Text>
            {recent.map((j) => (
              <Flex key={j.jobId} gap={3} alignItems="baseline" wrap>
                <Label theme={j.phase === "failed" ? "danger" : j.phase === "refused" ? "unknown" : "success"}>{jobPhaseLabel(j)}</Label>
                <Text>
                  <Text variant="code-1">{j.slug}</Text>
                  {j.error ? ` — ${j.error}` : ""}
                </Text>
              </Flex>
            ))}
          </Flex>
        )}
        <Button size="m" view="outlined" onClick={reload}>
          Обновить
        </Button>
      </Flex>
    </Card>
  );
}

interface FavoritesResponse {
  entries: import("../api/me").FavoriteEntry[];
}

function accessRow(access: import("../api/me").FavoriteEntry["access"]): string {
  if (!access) return "права ещё не проверяли";
  const mark = (v: boolean | null) => (v === null ? "?" : v ? "✓" : "✗");
  return `клон ${mark(access.clone)} · CI ${mark(access.ci)} · Security ${mark(access.appsec)}${access.own ? " · ваш" : ""}`;
}

/** Избранное: сейвить что угодно; права-ряд по факту; кулдаун 6ч. */
function FavoritesSection({ hasPat }: { hasPat: boolean }) {
  const favs = useJson<FavoritesResponse>("/api/me/favorites");
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ text: string; danger: boolean } | null>(null);
  if (favs.state.kind === "loading") return null;
  if (favs.state.kind === "error") {
    return (
      <Card view="outlined" style={{ padding: "var(--g-spacing-5)" }}>
        <Alert theme="warning" title="Раздел избранного не загрузился" message={favs.state.message} />
      </Card>
    );
  }
  const entries = favs.state.data.entries;

  const check = async (org: string, repo: string) => {
    setBusy(`${org}/${repo}`);
    setNote(null);
    try {
      const res = await mutateJson<{ access: import("../api/me").FavoriteEntry["access"]; enqueued: boolean }>(
        `/api/me/favorites/${encodeURIComponent(org)}/${encodeURIComponent(repo)}/check`,
        "POST",
      );
      setNote({ text: `${org}/${repo}: ${accessRow(res.access)}${res.enqueued ? " — запущен анализ (не чаще раза в 6 часов)" : ""}`, danger: false });
      favs.reload();
    } catch (e) {
      setNote({ text: e instanceof Error ? e.message : String(e), danger: true });
    } finally {
      setBusy(null);
    }
  };

  const remove = async (org: string, repo: string) => {
    setBusy(`${org}/${repo}`);
    try {
      await mutateJson(`/api/me/favorites/${encodeURIComponent(org)}/${encodeURIComponent(repo)}`, "DELETE");
      favs.reload();
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card view="outlined" style={{ padding: "var(--g-spacing-5)" }}>
      <Flex direction="column" gap={3}>
        <Flex direction="column" gap={1}>
          <Text variant="subheader-2">Избранное ★</Text>
          <Text color="secondary">
            Любой репозиторий — звёздочкой на его странице. «Проверить права» — живой запрос по вашему PAT;
            свой репозиторий пересканируется автоматически, не чаще раза в 6 часов.
          </Text>
          <Text color="secondary">✓ право есть · ✗ права нет · ? проверка не удалась или неизвестно</Text>
        </Flex>
        {entries.length === 0 && <Text color="secondary">пока пусто — добавьте звёздочкой со страницы репозитория</Text>}
        {entries.map((f) => (
          <Flex key={f.org + "/" + f.repo} gap={3} alignItems="center" wrap style={{ borderTop: "1px solid var(--g-color-line-generic)", paddingTop: "var(--g-spacing-3)" }}>
            <Flex direction="column" gap={1} style={{ minWidth: 220, flex: 1 }}>
              <Text>
                <Text variant="code-1">{f.org}/{f.repo}</Text>
              </Text>
              <Text color="secondary">
                {accessRow(f.access)}
                {f.lastCheckedAt ? ` · проверено ${fmtDateTime(f.lastCheckedAt)}` : ""}
              </Text>
            </Flex>
            {hasPat && (
              <Button size="m" view="outlined" disabled={busy !== null} onClick={() => void check(f.org, f.repo)}>
                Проверить права
              </Button>
            )}
            <Button size="m" view="flat" disabled={busy !== null} onClick={() => void remove(f.org, f.repo)}>
              Убрать ★
            </Button>
          </Flex>
        ))}
        {note && note.danger && <Alert theme="danger" title="Проверка прав не получилась" message={note.text} />}
        {note && !note.danger && <Text color="secondary">{note.text}</Text>}
      </Flex>
    </Card>
  );
}

/** Кабинетный контур заданий: ОДИН источник для панели (и для строк списка
 *  «моих репо» — статусы из серверных jobs, не useState; диагноз UX-2a). */
function CabinetJobs() {
  const { jobs, reload } = useMyJobs(5000);
  return (
    <Flex direction="column" gap={5}>
      <JobsPanel jobs={jobs} reload={reload} />
      <FavoritesGate jobsReload={reload} />
    </Flex>
  );
}

function FavoritesGate({ jobsReload }: { jobsReload: () => void }) {
  void jobsReload;
  const me = useMe();
  const hasPat = me.kind === "ok" && me.data.hasPat;
  return <FavoritesSection hasPat={hasPat} />;
}
