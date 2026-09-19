// MePage.tsx — «Личный кабинет» (В4/Б5): слои идентичности (Q4) — вход
// Я ID (UX), PAT SourceCraft (права на данные). Основная колонка — «мои
// репозитории» (PAT + ручной ввод слага — спискового юзерского эндпоинта
// в доках нет), запуск анализа с очередью и опросом статуса. Токен —
// настройка, поэтому живёт в правой панели: вставка → живая проверка →
// зашифрованное хранение, замена/удаление (удаление — с подтверждением).
// Секция «Бюджеты скана» удалена (К5 В4.1, PENDING Алексей): лимиты скана —
// только оператор. Ссылки ведут на единую карточку /repo/...
// Токен НИКОГДА не возвращается API и не логируется.
import { ArrowRightFromSquare, Clock, Key, Person } from "@gravity-ui/icons";
import { Alert, Button, Card, Dialog, Flex, Icon, Label, Link, Spin, Text, TextInput, useToaster } from "@gravity-ui/uikit";
import { useCallback, useEffect, useRef, useState } from "react";
import { type MeResponse, type MetaResponse, type MyReposResponse, type RepoCard, fetchJson, logout, mutateJson, useJson } from "./api";
import { authErrorText, fmtDateTime, fmtScore } from "./format";
import { linkProps, repoHref } from "./router";
import { Page, UserAvatar, displayName, logoutFailedToast } from "./Shell";
import { AsideSection, EmptyState, LanguageName, Meta, MetaItem, PageHeader, RepoAvatar, SkeletonRows } from "./ui";

const CRUMBS = [{ text: "Личный кабинет" }];

type ScanJobState = { sinceScanId: number; startedAt: number; seenScanId: number | null; phase: "queued" | "running" };

export function MePage({ meta }: { meta: MetaResponse | null }) {
  const me = useJson<MeResponse>("/api/me");
  // Ф2.9: горизонт опросов анализа — лиз job из /api/meta, не хардкод 20 минут
  const leaseMs = meta?.queue.leaseMs ?? 85 * 60_000;

  if (me.state.kind === "loading") {
    return (
      <Page crumbs={CRUMBS}>
        <SkeletonRows rows={4} height={56} />
      </Page>
    );
  }
  if (me.state.kind === "error" || me.state.data.login === null) {
    return <LoginOffer />;
  }
  const data = me.state.data;
  return (
    <Page
      crumbs={CRUMBS}
      aside={
        <>
          <AccountSection me={data} />
          <PatSection key={data.patCheckedAt ?? "no-pat"} hasPat={data.hasPat} checkedAt={data.patCheckedAt} onChanged={me.reload} />
        </>
      }
    >
      <PageHeader
        title="Личный кабинет"
        description={
          <>
            Вы вошли как <Text variant="code-inline-1">{data.login}</Text> (Я ID). Вход — это UX-слой; права на данные
            дает отдельный токен доступа SourceCraft, как на любом git-хостинге.
          </>
        }
      />
      <CabinetJobs />
      {/* Ф2.20: кабинет favorites-only — список живёт и без PAT; токен нужен
          для проверки прав, автозапуска и посева избранного из namespace */}
      <MyReposSection hasPat={data.hasPat} leaseMs={leaseMs} />
    </Page>
  );
}

/**
 * «Аккаунт» — кто вошёл и выход. Здесь выход доступен всегда, в том числе при
 * узком rail (там у аватара кнопки нет): кабинет — место настроек аккаунта.
 */
function AccountSection({ me }: { me: MeResponse }) {
  const toaster = useToaster();
  const name = displayName(me);
  return (
    <AsideSection title="Аккаунт">
      <Flex gap={3} alignItems="center">
        <UserAvatar me={me} />
        <Flex direction="column" style={{ minWidth: 0 }}>
          <Text variant="subheader-2" ellipsis>
            {name}
          </Text>
          <Text color="secondary" ellipsis>
            {name !== me.login ? me.login : "вход через Я ID"}
          </Text>
        </Flex>
      </Flex>
      <Button view="outlined" size="m" width="max" onClick={() => void logout().catch((e: unknown) => toaster.add(logoutFailedToast(e)))}>
        <Icon data={ArrowRightFromSquare} size={16} />
        Выйти
      </Button>
    </AsideSection>
  );
}

/** Не вошедшему — объяснение слоёв и кнопка входа (живой клик — приёмка HQ). */
function LoginOffer() {
  // Ф2.9: /me?auth_error=… после неудачного callback — причина показывается,
  // а не проглатывается
  const authError = new URLSearchParams(window.location.search).get("auth_error");
  return (
    <Page
      crumbs={CRUMBS}
      aside={
        <AsideSection title="Как это устроено">
          <Text color="complementary">
            Публичный рейтинг работает и без входа — раздел «Рейтинг». Блоки CI/CD и Security на карточке репозитория
            видны только тем, у кого есть к ним доступ на SourceCraft; в общий рейтинг они не вкладываются.
          </Text>
        </AsideSection>
      }
    >
      <PageHeader title="Личный кабинет" />
      {authError && (
        <Flex direction="column" gap={3} style={{ marginBottom: "var(--g-spacing-4)" }}>
          <Alert theme="danger" view="outlined" title="Вход через Я ID не завершен" message={authErrorText(authError)} />
        </Flex>
      )}
      <EmptyState
        icon={Person}
        title="Анализ своего репозитория"
        description="Сценарий «свой репо» состоит из двух слоев: вход через Я ID (кто вы у нас) и персональный токен SourceCraft (что платформа может вам показать — CI-раны и AppSec вашего репозитория). Токен создается в SourceCraft: Домой → Доступ → Персональные токены доступа."
        actions={[{ text: "Войти через Я ID", view: "action", size: "l", href: "/auth/ya" }]}
      />
    </Page>
  );
}

// ---------- токен (github-style: PUT проверяет живьём, DELETE убирает) ----------

function PatSection({ hasPat, checkedAt, onChanged }: { hasPat: boolean; checkedAt: string | null; onChanged: () => void }) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [owner, setOwner] = useState<string | null>(null);
  const [replacing, setReplacing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const toaster = useToaster();

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const res = await mutateJson<{ ok: boolean; tokenOwner: string | null }>("/api/me/pat", "PUT", { token });
      setOwner(res.tokenOwner);
      setToken("");
      toaster.add({ name: "pat-saved", theme: "success", title: hasPat ? "Токен заменен" : "Токен сохранен" });
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
      setConfirmDelete(false);
      toaster.add({ name: "pat-deleted", theme: "info", title: "Токен удален" });
      onChanged();
    } catch (e) {
      setConfirmDelete(false);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const tokenForm = (label: string, submit: string) => (
    <Flex direction="column" gap={2}>
      <TextInput
        type="password"
        size="m"
        placeholder={label}
        value={token}
        onUpdate={setToken}
        hasClear
        autoComplete="off"
        controlProps={{ "aria-label": label }}
      />
      <Button view="action" size="m" width="max" onClick={save} loading={busy} disabled={busy || token.length < 8}>
        {submit}
      </Button>
    </Flex>
  );

  return (
    <AsideSection title="Токен доступа">
      {hasPat ? (
        <Flex direction="column" gap={3}>
          <Flex gap={2} alignItems="center" wrap>
            <Label theme="success" size="xs">
              Сохранен
            </Label>
            <Text variant="body-short" color="secondary">
              проверен {fmtDateTime(checkedAt)}
            </Text>
          </Flex>
          {owner && <Text color="complementary">Токен принадлежит пользователю {owner}.</Text>}
          <Text variant="body-short" color="secondary">
            Токен хранится зашифрованным (AES-256-GCM) и никогда не возвращается обратно в браузер и не попадает в логи.
            Замена и удаление — сразу действуют на новые сканы.
          </Text>
          {replacing ? (
            tokenForm("Новый токен доступа", "Проверить и заменить")
          ) : (
            <Flex gap={2}>
              <Button view="normal" size="m" onClick={() => setReplacing(true)}>
                Заменить
              </Button>
              <Button view="outlined-danger" size="m" onClick={() => setConfirmDelete(true)} disabled={busy}>
                Удалить
              </Button>
            </Flex>
          )}
        </Flex>
      ) : (
        <Flex direction="column" gap={3}>
          <Flex gap={2} alignItems="center" wrap>
            <Label theme="warning" size="xs">
              Не задан
            </Label>
            <Text variant="body-short" color="secondary">
              свои репозитории недоступны
            </Text>
          </Flex>
          <Text variant="body-short" color="complementary">
            SourceCraft: Домой → Доступ → Персональные токены доступа → Сгенерировать новый токен. Токен показывается один
            раз — скопируйте его сразу. Перед сохранением мы проверяем его живым запросом GET /user: неверный токен
            платформа отклонит, и он не сохранится.
          </Text>
          {tokenForm("Токен доступа SourceCraft", "Проверить и сохранить")}
        </Flex>
      )}
      {error && <Alert theme="danger" view="outlined" size="s" title="Токен не сохранен" message={error} />}

      <Dialog open={confirmDelete} onClose={() => setConfirmDelete(false)} size="s" aria-label="Удаление токена">
        <Dialog.Header caption="Удалить токен?" />
        <Dialog.Body>
          <Text>Свои репозитории и запуск анализа станут недоступны, пока вы не добавите новый токен.</Text>
        </Dialog.Body>
        <Dialog.Footer
          preset="danger"
          textButtonApply="Удалить"
          textButtonCancel="Отмена"
          onClickButtonApply={() => void remove()}
          onClickButtonCancel={() => setConfirmDelete(false)}
          loading={busy}
        />
      </Dialog>
    </AsideSection>
  );
}

// ---------- мои репозитории: избранное + ручной ввод (слаг/URL) ----------

/** Светлая клиентская проверка ручного ввода: слаг org/repo или http(s)-ссылка; точную грамматику держит сервер. */
const INPUT_LIKELY = /^([a-z0-9_.-]+\/[a-z0-9_.-]+|https?:\/\/\S+)$/i;

function MyReposSection({ hasPat, leaseMs }: { hasPat: boolean; leaseMs: number }) {
  const repos = useJson<MyReposResponse>("/api/me/repos");
  const [jobs, setJobs] = useState<Record<string, ScanJobState>>({});
  const [manualSlug, setManualSlug] = useState("");
  const toaster = useToaster();
  const reposReloadRef = useRef(repos.reload);
  reposReloadRef.current = repos.reload;

  const startScan = useCallback(
    async (slug: string) => {
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
        toaster.add({ name: `scan-failed:${slug}`, theme: "danger", title: "Анализ не запущен", content: e instanceof Error ? e.message : String(e) });
      }
    },
    [toaster],
  );

  // опрос статуса запущенных анализов: 3с, не дольше лиза job (Ф2.9)
  useEffect(() => {
    const slugs = Object.keys(jobs);
    if (slugs.length === 0) return;
    const timer = setInterval(async () => {
      for (const slug of slugs) {
        const job = jobs[slug]!;
        if (Date.now() - job.startedAt > leaseMs) {
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
              toaster.add({ name: `scan-done:${slug}`, theme: "success", title: "Анализ завершен", content: slug });
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
  }, [jobs, toaster, leaseMs]);

  // Ф2.20: ручной ввод добавляет в избранное (слаг или URL); парсер —
  // серверный, клиент лишь не пускает заведомо не похожее
  const addManual = async () => {
    try {
      await mutateJson("/api/me/favorites", "PUT", { repository: manualSlug });
      setManualSlug("");
      toaster.add({ name: "fav-added", theme: "success", title: "Добавлено в избранное", content: manualSlug });
      repos.reload();
    } catch (e) {
      toaster.add({ name: "fav-failed", theme: "danger", title: "Не добавлено", content: e instanceof Error ? e.message : String(e) });
    }
  };

  const slugError = manualSlug !== "" && !INPUT_LIKELY.test(manualSlug) ? "формат: org/repo или ссылка" : undefined;

  return (
    <Flex direction="column" gap={3}>
      <Flex direction="column" gap={1}>
        <Text variant="subheader-2" as="h2">
          Мои репозитории
        </Text>
        <Text color="complementary">
          В списке — ваше избранное: репозитории, отмеченные звёздочкой на их страницах
          {hasPat ? ". Токен открывает проверку прав, автозапуск анализа и посев из вашего namespace при сохранении" : ""}. Добавить можно и вручную:
          слагом org/repo или ссылкой на репозиторий.
        </Text>
      </Flex>

      <Flex gap={2} alignItems="flex-start" wrap>
        <div style={{ flex: "1 1 240px", maxWidth: 360 }}>
          <TextInput
            size="m"
            placeholder="org/repo или ссылка"
            value={manualSlug}
            onUpdate={(v) => setManualSlug(v.trim())}
            hasClear
            controlProps={{ "aria-label": "Добавить репозиторий в избранное по слагу или ссылке" }}
            errorPlacement="outside"
            validationState={slugError ? "invalid" : undefined}
            errorMessage={slugError}
          />
        </div>
        <Button
          view="action"
          size="m"
          disabled={!INPUT_LIKELY.test(manualSlug)}
          onClick={() => void addManual()}
        >
          Добавить в избранное
        </Button>
      </Flex>

      {repos.state.kind === "loading" && <SkeletonRows rows={3} height={60} />}
      {repos.state.kind === "error" && (
        <Alert theme="warning" view="outlined" title="Список не получился" message={repos.state.message} actions={[{ text: "Повторить", handler: repos.reload }]} />
      )}
      {repos.state.kind === "ok" && repos.state.data.entries.length === 0 && (
        <Text color="secondary">
          В избранном пока пусто — отметьте репозиторий звёздочкой на его странице или добавьте слагом/ссылкой выше.
        </Text>
      )}
      {repos.state.kind === "ok" && repos.state.data.entries.length > 0 && (
        <ul className="rh-list">
          {repos.state.data.entries.map((entry) => {
            const slug = `${entry.org}/${entry.repo}`;
            return <RepoRow key={slug} entry={entry} job={jobs[slug] ?? null} onScan={() => void startScan(slug)} />;
          })}
        </ul>
      )}
    </Flex>
  );
}

function RepoRow({ entry, job, onScan }: { entry: MyReposResponse["entries"][number]; job: ScanJobState | null; onScan: () => void }) {
  const { org, repo } = entry;
  const scored = entry.healthcraftIndex !== null;
  return (
    <li className="rh-list__item">
      <Flex gap={4} alignItems="center" wrap>
        <RepoAvatar repo={repo} logoUrl={entry.logoUrl} size="m" />
        <Flex direction="column" gap={1} style={{ flex: "1 1 240px", minWidth: 0 }}>
          <Link {...linkProps(repoHref(org, repo))} view="primary">
            <Text variant="subheader-2">
              {org} / {repo}
            </Text>
          </Link>
          {entry.title && entry.title !== repo && <Text color="complementary">{entry.title}</Text>}
          <Meta>
            <MetaItem>
              <LanguageName name={entry.language} color={entry.languageColor} />
            </MetaItem>
            {entry.lastActivityAt && <MetaItem icon={Clock}>активность {fmtDateTime(entry.lastActivityAt)}</MetaItem>}
          </Meta>
        </Flex>

        {job ? (
          <Flex gap={2} alignItems="center">
            <Spin size="xs" />
            <Text color="complementary">{job.phase === "queued" ? "В очереди" : "Сканируется"}</Text>
          </Flex>
        ) : entry.planned ? (
          // Ф2.17 (решение 18.09): «данных нет» ≠ «данных не будет» — пока
          // заявка жива, кабинет показывает план вместо пустой строки; мета
          // и Score по-прежнему скрыты (fail-closed)
          <Label theme="info" size="xs">
            анализ запланирован, данные скоро будут
          </Label>
        ) : scored ? (
          <Flex direction="column" alignItems="flex-end" gap={0}>
            <Flex gap={1} alignItems="baseline">
              <Text variant="subheader-3">{fmtScore(entry.healthcraftIndex)}</Text>
              <Text color="secondary">/ 100 в рейтинге</Text>
            </Flex>
            {entry.lastScanAt && (
              <Text variant="body-short" color="secondary">
                {fmtDateTime(entry.lastScanAt)}
              </Text>
            )}
          </Flex>
        ) : (
          <Label theme="unknown" size="xs">
            Еще не анализировали
          </Label>
        )}

        <Button size="m" view={scored ? "normal" : "action"} onClick={onScan} disabled={job !== null}>
          {scored ? "Обновить анализ" : "Запустить анализ"}
        </Button>
      </Flex>
    </li>
  );
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
  // Ф2.15 / LOW-8 (решение владельца 18.09): очередью правит round-robin,
  // численный queueAhead — не FIFO-позиция; статус без числа
  if (j.phase === "queued") return "в очереди";
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
            {recent.map((j) => {
              const [org, repo] = j.slug.split("/");
              return (
                <Flex key={j.jobId} gap={3} alignItems="baseline" wrap>
                  <Label theme={j.phase === "failed" ? "danger" : j.phase === "refused" ? "unknown" : "success"}>{jobPhaseLabel(j)}</Label>
                  {/* Ф2.20: «Последние» кликабельны — карточка в одном клике */}
                  <Text>
                    <Link {...linkProps(repoHref(org ?? "", repo ?? ""))} view="primary">
                      <Text variant="code-1">{j.slug}</Text>
                    </Link>
                    {j.error ? ` — ${j.error}` : ""}
                  </Text>
                </Flex>
              );
            })}
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

/**
 * П2-UI (решения (1) и (2) 18.09): исход автопостановки анализа читается из
 * единственного поля `enqueue: {status, code}` — поля `enqueued` больше нет.
 * Причина отказа показывается человеку, а не глотается молча.
 */
function enqueueNote(enqueue: import("../api/me").FavoriteEnqueue): string {
  // М9 (круг 2): число часов из текста убрано — кулдаун настраивается
  // (`QUEUE_FAVORITE_OWN_COOLDOWN_MS`), а в тексте оно было зашито и врало бы
  // на любом стенде с другим значением
  if (enqueue.status === "queued") return "запущен анализ";
  if (enqueue.status === "deduplicated") return "анализ уже в очереди";
  if (enqueue.status === "skipped") {
    return enqueue.code === "not_own" ? "анализ доступен только для своих репозиториев" : "анализ запускали недавно";
  }
  switch (enqueue.code) {
    case "too_many_active":
      return "анализ не запущен: слишком много ваших анализов в очереди — дождитесь завершения";
    case "rate_limited":
      return "анализ не запущен: исчерпан часовой лимит запусков — попробуйте позже";
    case "no_access":
      return "анализ не запущен: ваш PAT не даёт доступа к этому репозиторию";
    case "pat_expired":
      return "анализ не запущен: SourceCraft отклонил PAT — обновите токен";
    default:
      return "анализ не запущен: не удалось проверить доступ к репозиторию";
  }
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
      // П2-UI: тип ответа экспортирован из src/api/me.ts — переименование
      // поля ловит tsc, а не пользователь (условие решения (1) 18.09)
      const res = await mutateJson<import("../api/me").FavoriteCheckResponse>(
        `/api/me/favorites/${encodeURIComponent(org)}/${encodeURIComponent(repo)}/check`,
        "POST",
      );
      setNote({ text: `${org}/${repo}: ${accessRow(res.access)} — ${enqueueNote(res.enqueue)}`, danger: false });
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
            свой репозиторий пересканируется автоматически, но не сразу после предыдущего анализа.
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
  const me = useJson<MeResponse>("/api/me");
  const hasPat = me.state.kind === "ok" && me.state.data.hasPat;
  return <FavoritesSection hasPat={hasPat} />;
}
