// MePage.tsx — пользовательские поверхности «Мои репозитории» и «Настройки»:
// Я ID (UX), PAT SourceCraft (права на данные). Основная колонна — ОДИН
// список «Мои репозитории» = избранное (В4.4, кластер I: дубль-секция
// «Избранное» удалена — права-ряд, проверка, звезда и анализ в одной
// строке). Токен — отдельная настройка на /settings: вставка → живая проверка →
// зашифрованное хранение, замена/удаление; исход посева из namespace
// показывается тостом (кластер I). Ссылки ведут на единую карточку /repo/...
// Токен НИКОГДА не возвращается API и не логируется.
import {
  ArrowRightFromSquare,
  ArrowsRotateRight,
  BarsAscendingAlignLeft,
  BarsDescendingAlignLeft,
  CircleCheck,
  CircleQuestion,
  Clock,
  Ellipsis,
  Key,
  Lock,
  Magnifier,
  Person,
  Plus,
  Star,
} from "@gravity-ui/icons";
import {
  ActionTooltip,
  Alert,
  type AlertProps,
  Button,
  Card,
  Dialog,
  DropdownMenu,
  Flex,
  HelpMark,
  Icon,
  type IconData,
  Label,
  Link,
  Select,
  Spin,
  Text,
  TextInput,
  useToaster,
} from "@gravity-ui/uikit";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { type MeResponse, type MetaResponse, type MyReposResponse, type RepoCard, fetchJson, logout, mutateJson, useJson } from "./api";
import { analysisOutcome, authErrorText, fmtDate, fmtDateTime, fmtScore, recommendationsText, scoreColor, scoreWord, slugOf } from "./format";
import { TAB_RECOMMENDATIONS } from "./RepoPage";
import { type Band, BANDS, type RepoEntry, type SortKey, SORT_DEFAULT_DESC, SORT_OPTIONS, countBands, filterEntries, sortEntries } from "./myRepos";
import { linkProps, repoHref } from "./router";
import { Page, UserAvatar, displayName, logoutFailedToast } from "./Shell";
import { AsideSection, EmptyState, LanguageName, Meta, MetaItem, PageHeader, RepoAvatar, RepoSlug, SkeletonRows } from "./ui";

const REPOS_CRUMBS = [{ text: "Мои репозитории" }];
const SETTINGS_CRUMBS = [{ text: "Настройки" }];

type ScanJobState = { sinceScanId: number; startedAt: number; seenScanId: number | null; phase: "queued" | "running" | "stalled" };

/**
 * В4.7 (П3.4): ОДНА плашка кабинета. До вехи семь `Alert` стояли в трёх
 * сочетаниях view/size и двух темах на одно и то же событие «не загрузилось».
 * Теперь view и size общие для всех, тема — по смыслу: ошибка (`danger`) или
 * подсказка, что делать дальше (`info`, плашка про токен П3.3).
 */
function CabinetAlert({
  theme = "danger",
  title,
  message,
  actions,
}: {
  theme?: "danger" | "info";
  title: string;
  message?: ReactNode;
  actions?: AlertProps["actions"];
}) {
  return <Alert theme={theme} view="outlined" size="m" title={title} message={message} actions={actions} />;
}

export function MePage({ meta }: { meta: MetaResponse | null }) {
  const me = useJson<MeResponse>("/api/me");
  // Ф2.9: горизонт опросов анализа — лиз job из /api/meta, не хардкод 20 минут
  const leaseMs = meta?.queue.leaseMs ?? 85 * 60_000;
  // В4.4 (кластер M-14): ОДИН источник статусов — серверные jobs; строка
  // списка предпочитает их локальному опросу (диагноз UX: два источника).
  // Аноним не опрашивает вовсе (см. useMyJobs)
  const jobs = useMyJobs(5000, me.state.kind === "ok" && me.state.data.login !== null);

  if (me.state.kind === "loading") {
    return (
      <Page crumbs={REPOS_CRUMBS}>
        <SkeletonRows rows={4} height={56} />
      </Page>
    );
  }
  if (me.state.kind === "error") {
    // В4.4 (кластер M-3): сбой /api/me — честная ошибка с повтором, не LoginOffer
    return (
      <Page crumbs={REPOS_CRUMBS}>
        <CabinetAlert title="Не удалось загрузить список репозиториев" message={me.state.message} actions={[{ text: "Повторить", handler: me.reload }]} />
      </Page>
    );
  }
  if (me.state.data.login === null) {
    return <LoginOffer pageTitle="Мои репозитории" />;
  }
  const data = me.state.data;
  return (
    // В4.8 (вариант A, решение 21.09): одна колонна — список, как у списков
    // SourceCraft. Журнал «Мои задания» из тела страницы убран: статус анализа
    // живет в строке, история — в «Заданиях» шапки (`JobsBell`). Правая
    // панель «Аккаунт» здесь дублировала аватар rail — осталась в Настройках.
    <Page crumbs={REPOS_CRUMBS}>
      {/* В4.4 (кластер I): список favorites-only живет и без PAT;
          токен нужен для проверки прав, автозапуска и посева из namespace */}
      <MyReposSection hasPat={data.hasPat} leaseMs={leaseMs} serverJobs={jobs.jobs} />
    </Page>
  );
}

export function SettingsPage() {
  const me = useJson<MeResponse>("/api/me");
  if (me.state.kind === "loading") {
    return (
      <Page crumbs={SETTINGS_CRUMBS}>
        <SkeletonRows rows={4} height={56} />
      </Page>
    );
  }
  if (me.state.kind === "error") {
    return (
      <Page crumbs={SETTINGS_CRUMBS}>
        <CabinetAlert title="Не удалось загрузить настройки" message={me.state.message} actions={[{ text: "Повторить", handler: me.reload }]} />
      </Page>
    );
  }
  if (me.state.data.login === null) return <LoginOffer pageTitle="Настройки" />;
  const data = me.state.data;
  return (
    <Page crumbs={SETTINGS_CRUMBS} aside={<AccountSection me={data} />}>
      <PatSection key={data.patCheckedAt ?? "no-pat"} hasPat={data.hasPat} checkedAt={data.patCheckedAt} onChanged={me.reload} />
    </Page>
  );
}

/**
 * «Аккаунт» — кто вошёл и выход. Здесь выход доступен всегда, в том числе при
 * узком rail (там у аватара кнопки нет): обе пользовательские поверхности
 * сохраняют доступ к управлению аккаунтом.
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
function LoginOffer({ pageTitle }: { pageTitle: "Мои репозитории" | "Настройки" }) {
  // Ф2.9: /me?auth_error=… после неудачного callback — причина показывается,
  // а не проглатывается
  const authError = new URLSearchParams(window.location.search).get("auth_error");
  return (
    <Page
      crumbs={[{ text: pageTitle }]}
      aside={
        <AsideSection title="Как это устроено">
          <Text color="complementary">
            Публичный рейтинг работает и без входа – раздел «Рейтинг». Блоки CI/CD и Security на карточке репозитория
            видны только тем, у кого есть к ним доступ на SourceCraft; в общий рейтинг они не вкладываются.
          </Text>
        </AsideSection>
      }
    >
      <PageHeader title={pageTitle} />
      {authError && (
        <Flex direction="column" gap={3} style={{ marginBottom: "var(--g-spacing-4)" }}>
          <CabinetAlert title="Вход через Я ID не завершен" message={authErrorText(authError)} />
        </Flex>
      )}
      <EmptyState
        icon={pageTitle === "Настройки" ? Key : Person}
        title={pageTitle === "Настройки" ? "Настройки доступны после входа" : "Мои репозитории доступны после входа"}
        description={
          pageTitle === "Настройки"
            ? "Войдите через Я ID, чтобы настроить токен доступа SourceCraft."
            : "Войдите через Я ID, чтобы управлять избранными репозиториями и запускать их анализ."
        }
        actions={[{ text: "Войти через Я ID", view: "action", size: "l", href: "/auth/ya" }]}
      />
    </Page>
  );
}

// ---------- токен (github-style: PUT проверяет живьём, DELETE убирает) ----------

/** В4.4 (кластер I): исход посева избранного из namespace — человеческой строкой. */
function seedNote(seed: import("../api/me").PatSeed | undefined): string {
  if (seed === undefined) return "Посев избранного из вашего namespace не выполнялся.";
  if (seed.status === "ok") return `Посев избранного из namespace: добавлено ${seed.added}.`;
  const why =
    seed.error?.code === "favorite_limit"
      ? "достигнут предел избранного"
      : seed.error?.code === "page_limit"
        ? "прочитаны не все страницы namespace"
        : seed.error?.code === "no_username"
          ? // UX-9 (круг 2 В4.4): namespace не опрашивался — не обвинять его
            "не удалось начать посев – SourceCraft не вернул имя пользователя"
          : "namespace ответил сбоем";
  return `Посев избранного остановлен: ${why} (добавлено ${seed.added}).`;
}

function PatSection({ hasPat, checkedAt, onChanged }: { hasPat: boolean; checkedAt: string | null; onChanged: () => void }) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [owner, setOwner] = useState<string | null>(null);
  const [replacing, setReplacing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // В4.4 (кластер M-6): заголовок ошибки — по операции (сохранение/удаление)
  const [failedOp, setFailedOp] = useState<"save" | "remove">("save");
  const toaster = useToaster();

  async function save() {
    setBusy(true);
    setError(null);
    setFailedOp("save");
    try {
      // В4.4 (кластер I): исход посева показывается сразу — PAT уже сохранён,
      // но что стало с избранного из namespace, юзер раньше не узнавал вовсе
      const res = await mutateJson<{ ok: boolean; tokenOwner: string | null; seed?: import("../api/me").PatSeed }>(
        "/api/me/pat",
        "PUT",
        { token },
      );
      setOwner(res.tokenOwner);
      setToken("");
      toaster.add({
        name: "pat-saved",
        theme: "success",
        title: hasPat ? "Токен заменен" : "Токен сохранен",
        content: `${res.tokenOwner ? `Владелец токена: ${res.tokenOwner}. ` : ""}${seedNote(res.seed)}`,
      });
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
    setFailedOp("remove");
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
    <Card view="outlined" className="rh-settings-card">
      <Flex as="section" direction="column" gap={3}>
        <Text variant="subheader-2" as="h2">
          Токен доступа SourceCraft
        </Text>
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
              Токен хранится в зашифрованном виде (AES-256-GCM), не возвращается в браузер и не записывается в журналы. Изменения
              применяются к последующим анализам.
            </Text>
            {replacing ? (
              <Flex direction="column" gap={2}>
                {tokenForm("Новый токен доступа", "Проверить и заменить")}
                {/* В4.4 (кластер M-8): выход из режима замены — явная «Отмена» */}
                <Button view="normal" size="m" width="max" onClick={() => setReplacing(false)} disabled={busy}>
                  Отмена
                </Button>
              </Flex>
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
              раз – скопируйте его сразу. Перед сохранением мы проверяем его живым запросом GET /user: неверный токен
              платформа отклонит, и он не сохранится.
            </Text>
            {tokenForm("Токен доступа SourceCraft", "Проверить и сохранить")}
          </Flex>
        )}
        {error && (
          <CabinetAlert title={failedOp === "save" ? "Токен не сохранен" : "Токен не удален"} message={error} />
        )}

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
      </Flex>
    </Card>
  );
}

// ---------- мои репозитории: ОДИН список = избранное (В4.4, кластер I) ----------

/** Светлая клиентская проверка ручного ввода: слаг org/repo или http(s)-ссылка; точную грамматику держит сервер. */
const INPUT_LIKELY = /^([a-z0-9_.-]+\/[a-z0-9_.-]+|https?:\/\/\S+)$/i;


function MyReposSection({ hasPat, leaseMs, serverJobs }: { hasPat: boolean; leaseMs: number; serverJobs: JobsResponse | null }) {
  const repos = useJson<MyReposResponse>("/api/me/repos");
  const favs = useJson<FavoritesResponse>("/api/me/favorites");
  const [jobs, setJobs] = useState<Record<string, ScanJobState>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState("");
  const [band, setBand] = useState<Band | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("index");
  const [sortDesc, setSortDesc] = useState(true);
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

  // опрос статуса запущенных анализов: 3с, не дольше лиза job (Ф2.9).
  // В4.4 (кластер E): исход — по СТАТУСУ скана (bad → ошибка, не success);
  // В4.4 (кластер M-5): после leaseMs — «затянулось», не молчаливое снятие
  useEffect(() => {
    const slugs = Object.keys(jobs);
    if (slugs.length === 0) return;
    const timer = setInterval(async () => {
      for (const slug of slugs) {
        const job = jobs[slug]!;
        if (job.phase === "stalled") {
          // З2 (круг 2 В4.4): stalled не замораживает строку навсегда — когда
          // серверная job ушла из active (исход есть в заданиях шапки), метка
          // снимается и строка перечитывает серверную правду
          const stillActive = serverJobs?.active.some((j) => j.slug === slug) ?? true;
          if (!stillActive) {
            setJobs((prev) => {
              const next = { ...prev };
              delete next[slug];
              return next;
            });
            reposReloadRef.current();
          }
          continue;
        }
        if (Date.now() - job.startedAt > leaseMs) {
          setJobs((prev) => ({ ...prev, [slug]: { ...job, phase: "stalled" } }));
          continue;
        }
        try {
          const [org, repo] = slug.split("/");
          const card = await fetchJson<RepoCard>(`/api/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}`);
          if (card.scan && card.scan.id > job.sinceScanId) {
            const outcome = analysisOutcome(card.scan);
            if (outcome !== "pending") {
              setJobs((prev) => {
                const next = { ...prev };
                delete next[slug];
                return next;
              });
              if (outcome === "ok") {
                toaster.add({ name: `scan-done:${slug}`, theme: "success", title: "Анализ завершен", content: slug });
              } else {
                toaster.add({
                  name: `scan-failed:${slug}`,
                  theme: "danger",
                  title: "Анализ завершился ошибкой",
                  content: `${slug}: сбор данных не удался – подробности в «Заданиях» в шапке`,
                });
              }
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
  }, [jobs, toaster, leaseMs, serverJobs]);

  const check = async (org: string, repo: string) => {
    setBusy(`${org}/${repo}`);
    try {
      // П2-UI: тип ответа экспортирован из src/api/me.ts — переименование
      // поля ловит tsc, а не пользователь (условие решения (1) 18.09)
      const res = await mutateJson<import("../api/me").FavoriteCheckResponse>(
        `/api/me/favorites/${encodeURIComponent(org)}/${encodeURIComponent(repo)}/check`,
        "POST",
      );
      // В4.8: исход — тостом, как у остальных действий строки; права видны в строке
      toaster.add({ name: `check:${org}/${repo}`, theme: "success", title: "Доступ проверен", content: `${slugOf(org, repo)}: ${enqueueNote(res.enqueue)}` });
      favs.reload();
      reposReloadRef.current();
    } catch (e) {
      toaster.add({ name: `check-failed:${org}/${repo}`, theme: "danger", title: "Проверка доступа не получилась", content: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  };

  const removeFav = async (org: string, repo: string) => {
    setBusy(`${org}/${repo}`);
    try {
      await mutateJson(`/api/me/favorites/${encodeURIComponent(org)}/${encodeURIComponent(repo)}`, "DELETE");
      toaster.add({ name: `fav-removed:${org}/${repo}`, theme: "info", title: "Убрано из избранного", content: slugOf(org, repo) });
      favs.reload();
      reposReloadRef.current();
    } catch (e) {
      // UX-7 (круг 2 В4.4): сбой снятия не глотается
      toaster.add({
        name: `fav-remove-failed:${org}/${repo}`,
        theme: "danger",
        title: "Не удалось убрать из избранного",
        content: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setBusy(null);
    }
  };

  const entries = repos.state.kind === "ok" ? repos.state.data.entries : [];
  const accessBySlug = new Map((favs.state.kind === "ok" ? favs.state.data.entries : []).map((f) => [`${f.org}/${f.repo}`, f]));
  const counts = countBands(entries);
  const shown = sortEntries(filterEntries(entries, query, band), sortKey, sortDesc);

  const addButton = (
    <Button view="action" size="m" onClick={() => setAdding(true)}>
      <Icon data={Plus} size={16} />
      Добавить
    </Button>
  );

  return (
    <Flex direction="column" gap={4}>
      {/* В4.8: шапка списка по образцу SourceCraft («Active issues 39»):
          заголовок header-1, счетчик цветом hint, справа поиск, сортировка и
          единственное action-действие страницы. Абзац-инструкция уехал в
          подсказку у заголовка: первый экран — под список, а не под механику. */}
      <div className="rh-me-head">
        <Flex gap={2} alignItems="center" style={{ minWidth: 0 }}>
          <Text variant="header-1" as="h1">
            Мои репозитории
          </Text>
          {repos.state.kind === "ok" && (
            <Text variant="header-1" color="hint">
              {entries.length}
            </Text>
          )}
          <HelpMark iconSize="m" aria-label="Откуда берутся репозитории">
            Здесь ваше избранное: отметьте репозиторий звездочкой на его странице или добавьте его по идентификатору org/repo или
            ссылке.
          </HelpMark>
        </Flex>
        <div className="rh-me-tools">
          <TextInput
            size="m"
            className="rh-me-search"
            placeholder="Найти репозиторий"
            value={query}
            onUpdate={setQuery}
            hasClear
            startContent={<Icon data={Magnifier} size={14} className="rh-me-search__icon" />}
            controlProps={{ "aria-label": "Найти репозиторий в избранном" }}
          />
          <Flex>
            <Select
              size="m"
              pin="round-brick"
              width="auto"
              value={[sortKey]}
              options={SORT_OPTIONS}
              onUpdate={([v]) => {
                const key = (v as SortKey) ?? "index";
                setSortKey(key);
                setSortDesc(SORT_DEFAULT_DESC[key]);
              }}
              aria-label="Сортировка"
            />
            <ActionTooltip title={sortDesc ? "По убыванию" : "По возрастанию"}>
              <Button view="normal" size="m" pin="brick-round" onClick={() => setSortDesc((d) => !d)} aria-label="Сменить направление сортировки">
                <Icon data={sortDesc ? BarsDescendingAlignLeft : BarsAscendingAlignLeft} size={16} />
              </Button>
            </ActionTooltip>
          </Flex>
          {addButton}
        </div>
      </div>

      {/* В4.7 (П3.3): без токена — блок с тем, что делать, и ссылкой в
          Настройки. Не тост (исчезает) и не подсказка в title (не видна). */}
      {!hasPat && (
        <CabinetAlert
          theme="info"
          title="Добавьте токен доступа SourceCraft"
          message="С токеном можно проверить доступ к своим репозиториям, запустить их анализ и увидеть CI/CD и Security на карточке. Токен добавляется в Настройках."
          actions={
            <Button view="normal" size="m" {...linkProps("/settings")}>
              Перейти в Настройки
            </Button>
          }
        />
      )}

      {repos.state.kind === "loading" && <SkeletonRows rows={3} height={66} />}
      {repos.state.kind === "error" && (
        <CabinetAlert title="Список не получился" message={repos.state.message} actions={[{ text: "Повторить", handler: repos.reload }]} />
      )}
      {/* З1 (круг 2 В4.4): сбой /api/me/favorites больше не глотается */}
      {favs.state.kind === "error" && (
        <CabinetAlert title="Раздел избранного не получился" message={favs.state.message} actions={[{ text: "Повторить", handler: favs.reload }]} />
      )}

      {repos.state.kind === "ok" && entries.length === 0 && (
        <EmptyState
          icon={Star}
          title="В избранном пока пусто"
          description="Отметьте репозиторий звездочкой на его странице или добавьте его по идентификатору org/repo или ссылке."
          actions={[{ text: "Добавить репозиторий", view: "action", size: "m", onClick: () => setAdding(true) }]}
        />
      )}

      {repos.state.kind === "ok" && entries.length > 0 && (
        <>
          {/* В4.8 (плитки варианта C): сводка по полосам шкалы — она же фильтр.
              Карточка `selection` Gravity: повторный клик снимает фильтр. */}
          <div className="rh-summary" role="group" aria-label="Сводка по шкале HealthCraft Index">
            {BANDS.map((b) => (
              <Card
                key={b.key}
                type="selection"
                view="outlined"
                selected={band === b.key}
                className="rh-summary__tile"
                onClick={() => setBand((cur) => (cur === b.key ? null : b.key))}
                title={b.hint}
                aria-pressed={band === b.key}
              >
                <Text variant="header-1" color={counts[b.key] > 0 && b.key !== "none" ? BAND_COLOR[b.key] : "primary"}>
                  {counts[b.key]}
                </Text>
                <Text color="secondary">{b.title}</Text>
              </Card>
            ))}
          </div>

          {shown.length === 0 ? (
            <EmptyState
              icon={Magnifier}
              title="Ничего не нашлось"
              description="Под поиск и выбранную плитку сводки не подходит ни один репозиторий."
              actions={[
                {
                  text: "Сбросить",
                  view: "normal",
                  size: "m",
                  onClick: () => {
                    setQuery("");
                    setBand(null);
                  },
                },
              ]}
            />
          ) : (
            <ul className="rh-repo-list">
              {shown.map((entry) => {
                const slug = `${entry.org}/${entry.repo}`;
                return (
                  <RepoRow
                    key={slug}
                    entry={entry}
                    access={accessBySlug.get(slug)?.access ?? null}
                    lastCheckedAt={accessBySlug.get(slug)?.lastCheckedAt ?? null}
                    hasPat={hasPat}
                    job={jobs[slug] ?? null}
                    serverJob={serverJobs?.active.find((j) => j.slug === slug) ?? null}
                    busy={busy !== null}
                    etaNote={`обычно до ${Math.max(1, Math.round(leaseMs / 60_000))} минут`}
                    onScan={() => void startScan(slug)}
                    onCheck={() => void check(entry.org, entry.repo)}
                    onRemove={() => void removeFav(entry.org, entry.repo)}
                  />
                );
              })}
            </ul>
          )}
        </>
      )}

      <AddRepoDialog
        open={adding}
        onClose={() => setAdding(false)}
        onAdded={() => {
          setAdding(false);
          repos.reload();
          favs.reload();
        }}
      />
    </Flex>
  );
}

const BAND_COLOR: Record<Exclude<Band, "none">, "positive-heavy" | "warning-heavy" | "danger-heavy"> = {
  success: "positive-heavy",
  warning: "warning-heavy",
  danger: "danger-heavy",
};

/**
 * В4.8: добавление — редкое действие, поэтому диалогом по кнопке в шапке
 * списка, а не полем над списком. Ф2.20: слаг или URL; парсер серверный,
 * клиент лишь не пускает заведомо не похожее.
 */
function AddRepoDialog({ open, onClose, onAdded }: { open: boolean; onClose: () => void; onAdded: () => void }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toaster = useToaster();
  const inputRef = useRef<HTMLInputElement>(null);
  const slugError = value !== "" && !INPUT_LIKELY.test(value) ? "Формат: org/repo или ссылка на репозиторий" : undefined;

  const close = () => {
    setValue("");
    setError(null);
    onClose();
  };

  const add = async () => {
    if (!INPUT_LIKELY.test(value)) {
      setError("Введите org/repo или ссылку на репозиторий");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await mutateJson("/api/me/favorites", "PUT", { repository: value });
      toaster.add({ name: "fav-added", theme: "success", title: "Добавлено в избранное", content: value });
      setValue("");
      onAdded();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={close} size="s" aria-label="Добавить репозиторий" initialFocus={inputRef}>
      <Dialog.Header caption="Добавить репозиторий" />
      <Dialog.Body>
        <Flex direction="column" gap={2} className="rh-add-repo">
          <Text color="secondary">Репозиторий попадет в избранное и появится в этом списке.</Text>
          <TextInput
            size="m"
            controlRef={inputRef}
            placeholder="org/repo или ссылка"
            value={value}
            onUpdate={(v) => {
              setValue(v.trim());
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") void add();
            }}
            hasClear
            controlProps={{ "aria-label": "Идентификатор org/repo или ссылка на репозиторий" }}
            errorPlacement="outside"
            validationState={slugError || error ? "invalid" : undefined}
            errorMessage={slugError ?? error ?? undefined}
          />
        </Flex>
      </Dialog.Body>
      <Dialog.Footer
        textButtonApply="Добавить"
        textButtonCancel="Отмена"
        onClickButtonApply={() => void add()}
        onClickButtonCancel={close}
        loading={busy}
      />
    </Dialog>
  );
}

/**
 * В4.8: строка репозитория по образцу `ListingItem` SourceCraft (замер
 * 21.09): отступ 12px, шаг 16px, квадратный аватар 40px, имя subheader-2,
 * мета-строка 13px вторичным цветом, делитель — `line-generic`. Строка
 * целиком ведет в карточку (слой-ссылка под содержимым), интерактивные
 * элементы стоят над ним. Справа — оценка словом шкалы или состояние
 * анализа; действия — одна кнопка по состоянию и меню.
 */
function RepoRow({
  entry,
  access,
  lastCheckedAt,
  hasPat,
  job,
  serverJob,
  busy,
  etaNote,
  onScan,
  onCheck,
  onRemove,
}: {
  entry: RepoEntry;
  access: import("../api/me").FavoriteAccess | null;
  lastCheckedAt: string | null;
  hasPat: boolean;
  job: ScanJobState | null;
  serverJob: import("../api/me").MyJob | null;
  busy: boolean;
  /** M-4: «обычно до N минут» — из лиза job (/api/meta) */
  etaNote: string;
  onScan: () => void;
  onCheck: () => void;
  onRemove: () => void;
}) {
  const { org, repo } = entry;
  const href = repoHref(org, repo);
  const scored = entry.healthcraftIndex !== null;
  const inWork = job !== null || serverJob !== null;
  // В4.4 (кластер M-14): серверный статус job — приоритетнее локального опроса
  const phase = serverJob ? serverJob.phase : job ? job.phase : null;

  const state =
    phase === "stalled" ? (
      <Label theme="warning" size="xs" title="Анализ идет дольше обычного – его исход появится в «Заданиях» в шапке">
        затянулось
      </Label>
    ) : phase !== null ? (
      <Label theme="info" size="xs" icon={<Spin size="xs" />} title={etaNote}>
        {phase === "queued" ? "В очереди" : "Сканируется"}
      </Label>
    ) : entry.planned ? (
      // Ф2.17 (решение 18.09): «данных нет» ≠ «данных не будет»; мета и Score
      // по-прежнему скрыты (fail-closed)
      <Label theme="info" size="xs" title="Анализ запланирован, данные скоро будут">
        Запланирован
      </Label>
    ) : scored ? (
      <div className="rh-repo-item__score" title="HealthCraft Index – публичная оценка репозитория">
        <Text variant="header-1" color={scoreColor(entry.healthcraftIndex)}>
          {fmtScore(entry.healthcraftIndex)}
        </Text>
        <Text variant="body-short" color="secondary">
          {scoreWord(entry.healthcraftIndex)}
        </Text>
      </div>
    ) : entry.lastScanStatus === "running" ? (
      // З4 (круг 2 В4.4): running — легальный транзитный статус последнего скана
      <Label theme="info" size="xs" icon={<Spin size="xs" />} title={etaNote}>
        Сканируется
      </Label>
    ) : entry.lastScanStatus === "bad" ? (
      // З4: последний скан упал — честный статус; пригодный старый индекс
      // сработал бы веткой выше
      <Label theme="danger" size="xs" title="Анализ завершился ошибкой – запустите его еще раз">
        Ошибка анализа
      </Label>
    ) : entry.lastScanAt !== null ? (
      <Label theme="unknown" size="xs" title="Проанализировали – данных для оценки не хватило">
        Нет оценки
      </Label>
    ) : !entry.inCatalog ? (
      // UX-8 (круг 2 В4.4): явные признаки вместо прокси `title === null`
      <Label theme="unknown" size="xs">
        Нет в каталоге
      </Label>
    ) : !entry.mayRead ? (
      <Label theme="unknown" size="xs">
        Нет прав
      </Label>
    ) : (
      <Label theme="unknown" size="xs">
        Еще не анализировали
      </Label>
    );

  const menuItems = [
    ...(hasPat
      ? [{ text: "Проверить доступ", action: onCheck, disabled: busy, title: "Узнать по вашему токену, какие данные этого репозитория вам открыты" }]
      : []),
    ...(entry.recommendationsCount !== null && entry.recommendationsCount > 0
      ? [{ text: "Открыть рекомендации", href: `${href}?tab=${TAB_RECOMMENDATIONS}` }]
      : []),
    { text: "Убрать из избранного", action: onRemove, disabled: busy, theme: "danger" as const },
  ];

  return (
    <li className="rh-repo-item">
      {/* слой-ссылка: клик по пустому месту строки ведет в карточку; с клавиатуры
          и для скринридера ссылка — имя репозитория, слой из обхода убран */}
      <a className="rh-repo-item__cover" {...linkProps(href)} tabIndex={-1} aria-hidden="true" />
      <RepoAvatar repo={repo} logoUrl={entry.logoUrl} size="l" />
      <div className="rh-repo-item__content">
        <div className="rh-repo-item__head">
          {/* В4.7 (П3.4): слаг — общим `RepoSlug`, как на рейтинге и карточке */}
          <Link {...linkProps(href)} view="primary" className="rh-repo-item__name">
            <RepoSlug org={org} repo={repo} variant="subheader-2" />
          </Link>
          <AccessRights access={access} lastCheckedAt={lastCheckedAt} />
        </div>
        <Meta>
          <MetaItem>
            <LanguageName name={entry.language} color={entry.languageColor} />
          </MetaItem>
          {/* П5 (В4): у последней активности времени по смыслу нет — дата без времени */}
          {entry.lastActivityAt && <MetaItem icon={Clock}>активность {fmtDate(entry.lastActivityAt)}</MetaItem>}
          {entry.lastScanAt && scored && <MetaItem>анализ {fmtDateTime(entry.lastScanAt)}</MetaItem>}
          {/* В4.7 (П3.4, У26): счётчик рекомендаций — ссылкой на карточку с
              открытым табом. null (прав нет) — строки нет: не 0 */}
          {entry.recommendationsCount !== null && (
            <MetaItem>
              <Link {...linkProps(`${href}?tab=${TAB_RECOMMENDATIONS}`)} className="rh-repo-item__link">
                {recommendationsText(entry.recommendationsCount)}
              </Link>
            </MetaItem>
          )}
        </Meta>
        {entry.title && entry.title !== repo && (
          <Text color="complementary" ellipsis className="rh-repo-item__desc">
            {entry.title}
          </Text>
        )}
      </div>

      <div className="rh-repo-item__state">{state}</div>

      <div className="rh-repo-item__actions">
        {scored ? (
          <ActionTooltip title="Обновить анализ">
            <Button view="flat" size="m" onClick={onScan} disabled={inWork} aria-label="Обновить анализ">
              <Icon data={ArrowsRotateRight} size={16} />
            </Button>
          </ActionTooltip>
        ) : (
          <Button view="outlined" size="m" onClick={onScan} disabled={inWork}>
            Запустить анализ
          </Button>
        )}
        <DropdownMenu
          items={menuItems}
          popupProps={{ placement: "bottom-end" }}
          renderSwitcher={(props) => (
            <Button {...props} view="flat" size="m" aria-label="Действия с репозиторием">
              <Icon data={Ellipsis} size={16} />
            </Button>
          )}
        />
      </div>
    </li>
  );
}


// ========== ПОРТ 5 (hq-parallel): панель заданий ==========

interface JobsResponse {
  active: import("../api/me").MyJob[];
  recent: import("../api/me").MyJob[];
}

/** Опрос /api/me/jobs: чаще при активных (честная позиция вместо спиннера);
 *  бэкофф ×2 до 5 мин на сбоях/401 после успешных данных — истёкшая сессия
 *  не крутит вечный 20-секундный опрос (ищейка-7). `enabled=false` (аноним)
 *  не шлёт ни одного запроса — 401-зонд мусорил бы консоль (планка «ноль
 *  ошибок консоли» харнесса). */
function useMyJobs(idleMs = 5000, enabled = true): { jobs: JobsResponse | null; reload: () => void } {
  const [jobs, setJobs] = useState<JobsResponse | null>(null);
  const [tick, setTick] = useState(0);
  const hadData = useRef(false);
  const reload = useCallback(() => setTick((x) => x + 1), []);
  useEffect(() => {
    if (!enabled) return;
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
  }, [tick, idleMs, enabled]);
  return { jobs, reload };
}

function jobPhaseLabel(j: import("../api/me").MyJob): string {
  // Ф2.15 / LOW-8 (решение владельца 18.09): очередью правит round-robin,
  // численный queueAhead — не FIFO-позиция; статус без числа
  if (j.phase === "queued") return "в очереди";
  if (j.phase === "running") return "сканируется…";
  if (j.phase === "failed") return "ошибка";
  if (j.phase === "refused") return "отклонена предпроверкой";
  return "готово";
}

/** Колокольчик шапки: тихий в покое; «Задания ◷ N» с позициями; ⚠ с причиной. */
export function JobsBell() {
  const { jobs } = useMyJobs(20000);
  // M-1: до первого ответа /api/me/jobs — тишина, не danger «⚠ 0»
  if (jobs === null) return null;
  const active = jobs.active;
  const failed = jobs.recent.filter((j) => j.phase === "failed").length;
  if (active.length === 0 && failed === 0) return null;
  return (
    <details style={{ position: "relative" }}>
      <summary style={{ cursor: "pointer", listStyle: "none", whiteSpace: "nowrap" }} title="ваши анализы в очереди">
        <Label theme={active.length > 0 ? "info" : "danger"}>Задания {active.length > 0 ? `◷ ${active.length}` : `⚠ ${failed}`}</Label>
      </summary>
      <Card view="outlined" className="rh-me-card" style={{ position: "absolute", right: 0, top: "100%", zIndex: 10, marginTop: "var(--g-spacing-2)", minWidth: 360 }}>
        <Flex direction="column" gap={2}>
          <Text variant="subheader-3">Ваши задания</Text>
          {active.map((j) => (
            <Flex key={j.jobId} gap={2} alignItems="baseline">
              <JobSlug slug={j.slug} />
              <Text color="secondary">– {jobPhaseLabel(j)}</Text>
            </Flex>
          ))}
          {active.length === 0 && <Text color="secondary">активных нет; последняя ошибка ниже</Text>}
          {jobs?.recent
            .filter((j) => j.phase === "failed")
            .slice(0, 1)
            .map((j) => (
              <Flex key={j.jobId} gap={2} alignItems="baseline">
                <JobSlug slug={j.slug} />
                <Text color="danger">– {j.error ?? "ошибка"}</Text>
              </Flex>
            ))}
          <Link {...linkProps("/me")}>весь список – в разделе «Мои репозитории»</Link>
        </Flex>
      </Card>
    </details>
  );
}

interface FavoritesResponse {
  entries: import("../api/me").FavoriteEntry[];
}

/**
 * Слаг задания: серверная строка `org/repo` — общим `RepoSlug` (В4.7, П3.4:
 * один способ набрать слаг). У отклонённой без строки репозитория слага может
 * не быть вовсе («—») — тогда просто текст.
 */
function JobSlug({ slug, link = false }: { slug: string; link?: boolean }) {
  const [org, repo, ...rest] = slug.split("/");
  if (!org || !repo || rest.length > 0) return <Text color="secondary">{slug}</Text>;
  const view = <RepoSlug org={org} repo={repo} variant="body-1" />;
  return link ? (
    <Link {...linkProps(repoHref(org, repo))} view="primary">
      {view}
    </Link>
  ) : (
    view
  );
}

/** Каналы доступа в строке репозитория: ключ сохранённой проверки → подпись. */
const ACCESS_CHANNELS: { key: "clone" | "ci" | "appsec"; title: string }[] = [
  { key: "clone", title: "Код" },
  { key: "ci", title: "CI/CD" },
  { key: "appsec", title: "Security" },
];

/** Tri-state одного канала: есть доступ / нет доступа / неизвестно — иконкой и темой, словами — в подсказке. */
const ACCESS_STATES: Record<"yes" | "no" | "unknown", { theme: "success" | "unknown"; icon: IconData; hint: string }> = {
  yes: { theme: "success", icon: CircleCheck, hint: "доступ есть" },
  no: { theme: "unknown", icon: Lock, hint: "доступа нет" },
  unknown: { theme: "unknown", icon: CircleQuestion, hint: "проверка не удалась или результат неизвестен" },
};

/**
 * В4.7 (П3.2, П3.4): права зрителя на репозиторий — компонентами, как на
 * карточке (`Label` с иконкой; закрытое — замком), а не текстовыми глифами.
 * В4.8: чипы стоят рядом с именем, как «Protected» и «Default» у веток
 * SourceCraft. Без проверки строка молчит — фраза-инструкция в каждой строке
 * была шумом; путь «узнать» — пункт «Проверить доступ» в меню строки.
 * Дата проверки — в подсказке чипа, а не отдельным реквизитом.
 */
function AccessRights({ access, lastCheckedAt }: { access: import("../api/me").FavoriteEntry["access"]; lastCheckedAt: string | null }) {
  if (!access) return null;
  const checked = lastCheckedAt ? ` (проверено ${fmtDateTime(lastCheckedAt)})` : "";
  return (
    <Flex gap={1} alignItems="center" className="rh-repo-item__labels">
      {ACCESS_CHANNELS.map(({ key, title }) => {
        const value = access[key];
        const state = ACCESS_STATES[value === true ? "yes" : value === false ? "no" : "unknown"];
        return (
          <Label key={key} theme={state.theme} size="xs" icon={<Icon data={state.icon} size={12} />} title={`${title}: ${state.hint}${checked}`}>
            {title}
          </Label>
        );
      })}
      {access.own && (
        <Label theme="utility" size="xs" title="У вас есть доступ к данным CI/CD или Security, либо репозиторий приватный">
          ваш
        </Label>
      )}
    </Flex>
  );
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
      return "анализ не запущен: слишком много ваших анализов в очереди – дождитесь завершения";
    case "rate_limited":
      return "анализ не запущен: исчерпан часовой лимит запусков – попробуйте позже";
    case "no_access":
      return "анализ не запущен: ваш PAT не дает доступа к этому репозиторию";
    case "pat_expired":
      return "анализ не запущен: SourceCraft отклонил PAT – обновите токен";
    default:
      return "анализ не запущен: не удалось проверить доступ к репозиторию";
  }
}
