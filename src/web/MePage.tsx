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
  Bulb,
  CircleCheck,
  CircleDashed,
  CircleExclamation,
  CircleQuestion,
  Clock,
  Code,
  Ellipsis,
  Hourglass,
  Key,
  ListCheck,
  Lock,
  Magnifier,
  OctagonXmark,
  Person,
  Plus,
  Shield,
  Star,
  Terminal,
  TriangleExclamation,
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
  Icon,
  type IconData,
  Label,
  Link,
  Popup,
  SegmentedRadioGroup,
  Select,
  Text,
  TextInput,
  useToaster,
} from "@gravity-ui/uikit";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { type MeResponse, type MetaResponse, type MyReposResponse, type RepoCard, fetchJson, logout, mutateJson, useJson } from "./api";
import { analysisOutcome, authErrorText, fmtDateTime, fmtScore, recommendationsText, scoreTheme, scoreWord, sentence, slugOf } from "./format";
import { TAB_RECOMMENDATIONS } from "./RepoPage";
import { type Band, BANDS, type RepoEntry, type SortKey, SORT_DEFAULT_DESC, SORT_OPTIONS, countBands, filterEntries, groupJobsByDay, sortEntries } from "./myRepos";
import { linkProps, navigate, repoHref } from "./router";
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
        // круг 4 (замечание 4): «Задания» в шапке узнают о запуске сразу, а не
        // на следующем тике своего 20-секундного опроса
        announceJobsChanged();
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
      // проверка прав может поставить own-анализ (enqueue) — шапка узнает сразу
      announceJobsChanged();
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
          единственное action-действие страницы. Круг 2 (5b): вместо
          иконки-подсказки — строка описания под заголовком, как у рейтинга
          (слот `description` у `PageHeader`); «Здесь ваше избранное» ничего не
          объясняло (замечание 5 Екатерины). */}
      <div className="rh-me-head">
        <Flex direction="column" gap={1} className="rh-me-head__title">
          <Flex gap={2} alignItems="baseline">
            <Text variant="header-1" as="h1">
              Мои репозитории
            </Text>
            {repos.state.kind === "ok" && (
              <Text variant="header-1" color="hint">
                {entries.length}
              </Text>
            )}
          </Flex>
          {/* Круг 3 (2c): одна фраза-польза — прежние два предложения были
              длинными; у списков SourceCraft описание либо отсутствует, либо
              одно короткое («Milestones help group issues…») */}
          <Text color="complementary">Следите за здоровьем избранных репозиториев и тем, что возможно в них улучшить.</Text>
        </Flex>
        <div className="rh-me-tools">
          <TextInput
            size="m"
            className="rh-me-search"
            placeholder="Поиск"
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
          {/* Круг 2 (9a, 3c): число белое, цвет полосы — в графике: иконка
              полосы в углу плитки (у «Без оценки» иконки нет — это не полоса
              шкалы, решение Екатерины). Круг 3: полоса распределения под
              плитками снята (замечание 3). Круг 4: иконки 20px, «жирность» была от `stroke`, а не от размера. */}
          <div className="rh-summary-block">
            <div className="rh-summary" role="group" aria-label="Сводка по шкале HealthCraft Index">
              {BANDS.map((b) => {
                const icon = BAND_ICON[b.key];
                return (
                  <Card
                    key={b.key}
                    type="selection"
                    view="outlined"
                    selected={band === b.key}
                    className="rh-summary__tile"
                    onClick={() => setBand((cur) => (cur === b.key ? null : b.key))}
                    title={b.hint}
                    // ревью закрытия: `Card type="selection"` ставит role="radio" и
                    // aria-checked, а плитка — переключатель (повторный клик снимает
                    // фильтр): роль кнопки и aria-pressed
                    role="button"
                    aria-checked={undefined}
                    aria-pressed={band === b.key}
                  >
                    <div className="rh-summary__top">
                      <Text variant="header-1">{counts[b.key]}</Text>
                      {icon && <Icon data={icon} size={20} className={`rh-band-icon rh-band-icon_${b.key}`} />}
                    </div>
                    <Text color="secondary">{b.title}</Text>
                  </Card>
                );
              })}
            </div>
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

/** Иконка полосы на плитке сводки; у «Без оценки» иконки нет (круг 2, 9a). */
const BAND_ICON: Record<Band, IconData | null> = {
  success: CircleCheck,
  warning: TriangleExclamation,
  danger: OctagonXmark,
  none: null,
};

/**
 * Круг 2 (8a, 3c): оценка — кольцо-шкала с числом внутри. Число белое, цвет
 * полосы — насыщенным базовым тоном (`--g-color-base-*-heavy`) на дуге:
 * пастельные текстовые токены В4.6 читались бледно (замечание 3), а графике
 * контраст прозы 4,5:1 не нужен (порог нетекстовой графики — 3:1).
 */
function StatePill({ icon, tone, title, children }: { icon: IconData; tone?: "danger" | "warning"; title: string; children: ReactNode }) {
  return (
    <span className="rh-state" title={title}>
      <Icon data={icon} size={14} className={tone ? `rh-state__icon rh-state__icon_${tone}` : "rh-state__icon"} />
      {children}
    </span>
  );
}

function ScoreRing({ value }: { value: number }) {
  const r = 18;
  const circ = 2 * Math.PI * r;
  const shown = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <span className={`rh-ring rh-ring_${scoreTheme(value)}`}>
      <svg width="44" height="44" viewBox="0 0 44 44" aria-hidden="true">
        <circle className="rh-ring__track" cx="22" cy="22" r={r} />
        <circle className="rh-ring__arc" cx="22" cy="22" r={r} strokeDasharray={`${(shown / 100) * circ} ${circ}`} transform="rotate(-90 22 22)" />
      </svg>
      <Text variant="subheader-2" className="rh-ring__num">
        {fmtScore(value)}
      </Text>
    </span>
  );
}

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
              if (e.key === "Enter" && !busy) void add();
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

  // Круг 3 (замечание 8): все состояния без оценки — ОДНА серая плашка
  // `StatePill` (та же форма, что у «Сканируется»), смысл — иконкой и
  // подсказкой. Цветные `Label` читались тегами; цвет остался только у иконки
  // там, где он значит (ошибка — красный, затянулось — желтый).
  const state =
    phase === "stalled" ? (
      <StatePill icon={Hourglass} tone="warning" title="Анализ идет дольше обычного – его исход появится в «Заданиях» в шапке">
        Затянулось
      </StatePill>
    ) : phase !== null ? (
      // Круг 2 (1a): серая плашка с бегущей штриховкой — ровно состояние
      // загрузки кнопки Gravity (как «Отчет» на карточке), а не тег со спиннером
      <span className="rh-state rh-busy" title={etaNote}>
        {phase === "queued" ? "В очереди" : "Сканируется"}
      </span>
    ) : entry.planned ? (
      // Ф2.17 (решение 18.09): «данных нет» ≠ «данных не будет»; мета и Score
      // по-прежнему скрыты (fail-closed)
      <StatePill icon={Clock} title="Анализ запланирован, данные скоро будут">
        Запланирован
      </StatePill>
    ) : scored ? (
      <div className="rh-repo-item__score" title="HealthCraft Index – публичная оценка репозитория">
        <Text variant="subheader-1">{sentence(scoreWord(entry.healthcraftIndex))}</Text>
        <ScoreRing value={entry.healthcraftIndex!} />
      </div>
    ) : entry.lastScanStatus === "running" ? (
      // З4 (круг 2 В4.4): running — легальный транзитный статус последнего скана
      <span className="rh-state rh-busy" title={etaNote}>
        Сканируется
      </span>
    ) : entry.lastScanStatus === "bad" ? (
      // З4: последний скан упал — честный статус; пригодный старый индекс
      // сработал бы веткой выше
      <StatePill icon={CircleExclamation} tone="danger" title="Анализ завершился ошибкой – запустите его еще раз">
        Ошибка анализа
      </StatePill>
    ) : entry.lastScanAt !== null ? (
      <StatePill icon={CircleDashed} title="Проанализировали – данных для оценки не хватило">
        Нет оценки
      </StatePill>
    ) : !entry.inCatalog ? (
      // UX-8 (круг 2 В4.4): явные признаки вместо прокси `title === null`
      <StatePill icon={CircleQuestion} title="Репозитория нет в каталоге SourceCraft">
        Нет в каталоге
      </StatePill>
    ) : !entry.mayRead ? (
      <StatePill icon={Lock} title="Нет прав на данные репозитория – проверьте доступ">
        Нет прав
      </StatePill>
    ) : (
      <StatePill icon={CircleDashed} title="Анализ этого репозитория еще не запускали">
        Еще не анализировали
      </StatePill>
    );

  const menuItems = [
    ...(hasPat
      ? [{ text: "Проверить доступ", action: onCheck, disabled: busy, title: "Узнать по вашему токену, какие данные этого репозитория вам открыты" }]
      : []),
    ...(entry.recommendationsCount !== null && entry.recommendationsCount > 0
      ? // ревью закрытия: не `href` — пункт меню рендерится обычной ссылкой без
        // `linkProps` и перезагружал страницу; навигация — внутри приложения
        [{ text: "Открыть рекомендации", action: () => navigate(`${href}?tab=${TAB_RECOMMENDATIONS}`) }]
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
          {/* Круг 2 (7a): иконка вместо слова — круговая стрелка = последний
              анализ; смысл — в подсказке. Круг 3 (замечание 4): дата последней
              активности снята — в кабинете это лишний реквизит (она остается на
              карточке и в рейтинге). */}
          {entry.lastScanAt && scored && (
            <MetaItem icon={ArrowsRotateRight} title="Последний анализ">
              {fmtDateTime(entry.lastScanAt)}
            </MetaItem>
          )}
          {/* В4.7 (П3.4, У26): счётчик рекомендаций — ссылкой на карточку с
              открытым табом. null (прав нет) — строки нет: не 0 */}
          {entry.recommendationsCount !== null && (
            <MetaItem>
              {/* круг 2 (7a): иконка — внутри ссылки, чтобы красилась вместе с текстом */}
              <Link {...linkProps(`${href}?tab=${TAB_RECOMMENDATIONS}`)} className="rh-repo-item__link">
                <Icon data={Bulb} size={14} />
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
/** Событие «задания изменились» (В4.8 круг 4): запуск анализа в строке будит все опросы `useMyJobs`. */
const JOBS_CHANGED = "rh-jobs-changed";

function announceJobsChanged(): void {
  window.dispatchEvent(new Event(JOBS_CHANGED));
}

function useMyJobs(idleMs = 5000, enabled = true): { jobs: JobsResponse | null; reload: () => void } {
  const [jobs, setJobs] = useState<JobsResponse | null>(null);
  const [tick, setTick] = useState(0);
  const hadData = useRef(false);
  const reload = useCallback(() => setTick((x) => x + 1), []);
  useEffect(() => {
    window.addEventListener(JOBS_CHANGED, reload);
    return () => window.removeEventListener(JOBS_CHANGED, reload);
  }, [reload]);
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

/**
 * Кнопка «Задания» в шапке и ее панель.
 * Кнопка (круг 3, 6a / исследование — Т1): обычная кнопка Gravity; пока хоть
 * один анализ идет, по ней бежит та же штриховка, что у «Сканируется» в строке,
 * счетчик — отдельным span цветом hint. Без активных, но с ошибкой — иконка и
 * число цветом ошибки. Видна всегда (круг 4).
 * Панель (исследование `reports/2026-09-21-m48-jobs-research.md`, выбор П3 с
 * поправками Екатерины): `Popup` с фоном и тенью, БЕЗ заголовка — сверху сразу
 * переключатель «Активные N / История»; строки — логотип (`MyJob.logoUrl`),
 * имя ссылкой на карточку и та же серая плашка состояния, что в строке
 * списка (`rh-busy` / `StatePill`); снизу у активных — куда придет итог, без
 * оценки времени.
 */
export function JobsBell() {
  const { jobs } = useMyJobs(20000);
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"active" | "history" | null>(null);
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  // Круг 4 (замечание 4): кнопка видна всегда. До первого ответа /api/me/jobs
  // счетчика нет (M-1: не «⚠ 0»).
  const active = jobs?.active ?? [];
  const recent = jobs?.recent ?? [];
  const failed = recent.filter((j) => j.phase === "failed").length;
  const busy = active.length > 0;
  // ревью закрытия В4.8: тревога — только если ПОСЛЕДНЕЕ завершенное задание
  // упало (recent идет от новых к старым); прежнее «есть ошибка среди 8
  // последних» держало кнопку красной после трех успешных анализов подряд
  const alarm = !busy && recent[0]?.phase === "failed";
  // вкладка по умолчанию — где есть что смотреть: идут анализы → «Активные», иначе «История»
  const shown = tab ?? (busy ? "active" : "history");
  const close = () => {
    setOpen(false);
    setTab(null);
  };
  return (
    <>
      <Button
        ref={setAnchor}
        view="normal"
        size="m"
        className={busy ? "rh-jobs-btn rh-jobs-btn_busy" : "rh-jobs-btn"}
        onClick={() => (open ? close() : setOpen(true))}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={busy ? "Ваши анализы идут" : alarm ? "Последний анализ завершился ошибкой" : "Ваши анализы"}
      >
        <Icon data={alarm ? CircleExclamation : ListCheck} size={16} className={alarm ? "rh-state__icon_danger" : undefined} />
        Задания
        {jobs !== null && (
          <span className={alarm ? "rh-jobs-btn__count rh-jobs-btn__count_danger" : "rh-jobs-btn__count"}>{alarm ? failed : active.length}</span>
        )}
      </Button>
      <Popup
        open={open}
        onOpenChange={(next) => (next ? setOpen(true) : close())}
        anchorElement={anchor}
        placement="bottom-end"
        offset={4}
        role="dialog"
        aria-label="Ваши задания"
      >
        <div className="rh-jobs">
          <div className="rh-jobs__tabs">
            <SegmentedRadioGroup size="s" width="max" value={shown} onUpdate={(v) => setTab(v === "active" ? "active" : "history")} aria-label="Какие задания показать">
              <SegmentedRadioGroup.Option value="active">{`Активные ${active.length}`}</SegmentedRadioGroup.Option>
              <SegmentedRadioGroup.Option value="history">История</SegmentedRadioGroup.Option>
            </SegmentedRadioGroup>
          </div>
          {shown === "active" ? (
            active.length === 0 ? (
              // Круг 5 (2c): пустое состояние в формате наших заглушек, компактно
              // по центру — иконка, заголовок, описание со ссылкой в раздел
              <JobsEmpty title="Сейчас ничего не анализируется">
                Запустить анализ можно в разделе{" "}
                <Link {...navProps("/me", close)} view="normal">
                  Мои репозитории
                </Link>
              </JobsEmpty>
            ) : (
              <>
                <div className="rh-jobs__list">
                  {active.map((j) => (
                    <JobRow key={j.jobId} job={j} onNavigate={close} />
                  ))}
                </div>
                <Text color="secondary" className="rh-jobs__note">
                  Итог появится в строке репозитория.
                </Text>
              </>
            )
          ) : recent.length === 0 ? (
            <JobsEmpty title="Анализов пока не было">Здесь появятся завершенные анализы и их итог.</JobsEmpty>
          ) : (
            // прокрутка внутри панели (круг 5, замечание 4 Екатерины): длинная история не
            // растягивает панель за край окна. Круг 5 (4c): лента по дням —
            // заголовок дня, время справа, итог иконкой: повторные анализы одного
            // репозитория различимы по времени
            <div className="rh-jobs__list">
              {groupJobsByDay(recent).map((g) => (
                <section key={g.label} aria-label={g.label}>
                  <Text color="secondary" variant="caption-2" className="rh-jobs__day">
                    {g.label}
                  </Text>
                  {g.rows.map(({ job, time }) => (
                    <HistoryRow key={job.jobId} job={job} time={time} onNavigate={close} />
                  ))}
                </section>
              ))}
            </div>
          )}
        </div>
      </Popup>
    </>
  );
}

/**
 * Строка вкладки «Активные»: логотип, имя ссылкой на карточку, справа — та же
 * серая плашка со штриховкой, что у «Сканируется» в строке списка. Завершенные
 * задания живут на вкладке «История» (`HistoryRow`).
 */
function JobRow({ job, onNavigate }: { job: import("../api/me").MyJob; onNavigate: () => void }) {
  const [org, repo, ...rest] = job.slug.split("/");
  const valid = Boolean(org && repo && rest.length === 0);
  return (
    <div className="rh-jobs__row">
      <RepoAvatar repo={valid ? repo! : job.slug} logoUrl={job.logoUrl} size="xs" />
      <div className="rh-jobs__body">
        {valid ? (
          <Link {...navProps(repoHref(org!, repo!), onNavigate)} view="primary">
            <RepoSlug org={org!} repo={repo!} variant="body-1" />
          </Link>
        ) : (
          <Text color="secondary">{job.slug}</Text>
        )}
      </div>
      {/* Ф2.15 / LOW-8 (решение 18.09): очередью правит round-robin — статус без числа позиции */}
      <span className="rh-state rh-busy">{job.phase === "queued" ? "В очереди" : "Сканируется"}</span>
    </div>
  );
}

/**
 * Ссылка внутри панели: навигация SPA (`linkProps`) И закрытие панели.
 * Круг 5: прежде `onClick={onNavigate}` перекрывал `onClick` из `linkProps`,
 * и переход по имени перезагружал страницу целиком.
 */
function navProps(url: string, after: () => void): ReturnType<typeof linkProps> {
  const base = linkProps(url);
  return {
    href: base.href,
    onClick: (e) => {
      base.onClick(e);
      after();
    },
  };
}

/** Пустое состояние панели (круг 5, 2c): иконка сверху, заголовок, описание — компактно по центру. */
function JobsEmpty({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rh-jobs__empty">
      <Icon data={ListCheck} size={32} className="rh-jobs__empty-icon" />
      <Text variant="subheader-1">{title}</Text>
      <Text color="secondary">{children}</Text>
    </div>
  );
}

/** Итог задания в «Истории» иконкой (4c); словами — в подсказке и `aria-label`. */
const HISTORY_OUTCOME: Record<"done" | "failed" | "refused", { icon: IconData; cls: string; text: string }> = {
  done: { icon: CircleCheck, cls: "rh-state__icon_success", text: "Готово" },
  failed: { icon: CircleExclamation, cls: "rh-state__icon_danger", text: "Ошибка" },
  refused: { icon: CircleExclamation, cls: "rh-state__icon", text: "Отклонено предпроверкой токена" },
};

/**
 * Строка «Истории» (4c): логотип, имя ссылкой на карточку, справа время
 * взятия в работу и итог иконкой. У ошибки причина — второй строкой: ее и
 * нужно прочесть, чтобы понять, что делать.
 */
function HistoryRow({ job, time, onNavigate }: { job: import("../api/me").MyJob; time: string | null; onNavigate: () => void }) {
  const [org, repo, ...rest] = job.slug.split("/");
  const valid = Boolean(org && repo && rest.length === 0);
  const outcome = HISTORY_OUTCOME[job.phase === "failed" ? "failed" : job.phase === "refused" ? "refused" : "done"];
  const hint = job.phase === "failed" && job.error ? `${outcome.text}: ${job.error}` : outcome.text;
  return (
    <div className="rh-jobs__row">
      <RepoAvatar repo={valid ? repo! : job.slug} logoUrl={job.logoUrl} size="xs" />
      <div className="rh-jobs__body">
        {valid ? (
          <Link {...navProps(repoHref(org!, repo!), onNavigate)} view="primary">
            <RepoSlug org={org!} repo={repo!} variant="body-1" />
          </Link>
        ) : (
          <Text color="secondary">{job.slug}</Text>
        )}
        {job.phase === "failed" && job.error && (
          <Text color="secondary" variant="caption-2" ellipsis title={job.error}>
            {job.error}
          </Text>
        )}
      </div>
      {time && (
        <Text color="hint" className="rh-jobs__time">
          {time}
        </Text>
      )}
      <span className="rh-jobs__outcome" title={hint} aria-label={hint} role="img">
        <Icon data={outcome.icon} size={16} className={outcome.cls} />
      </span>
    </div>
  );
}

interface FavoritesResponse {
  entries: import("../api/me").FavoriteEntry[];
}

/**
 * Каналы доступа (В4.8 круг 3, 5a): иконки как у SourceCraft — `Code` (раздел
 * Code), `Terminal` (раздел Automations, там живет CI/CD), `Shield` (Security;
 * на карточке у подметрики «исправленные уязвимости» — `ShieldCheck`, здесь
 * без галочки, чтобы значок не спорил с состоянием).
 */
const ACCESS_CHANNELS: { key: "clone" | "ci" | "appsec"; title: string; icon: IconData }[] = [
  { key: "clone", title: "Код", icon: Code },
  { key: "ci", title: "CI/CD", icon: Terminal },
  { key: "appsec", title: "Security", icon: Shield },
];

/**
 * Tri-state канала — яркостью иконки, словами — в подсказке. Круг 4
 * (замечание 2): без зеленого — есть доступ светло-серым, нет или неизвестно
 * серым (как у публичных репозиториев); «нет» и «неизвестно» различаются
 * словами в подсказке и `aria-label`.
 */
const ACCESS_STATES: Record<"yes" | "no" | "unknown", { cls: string; hint: string }> = {
  yes: { cls: "rh-access__icon_yes", hint: "доступ есть" },
  no: { cls: "rh-access__icon_no", hint: "доступа нет" },
  unknown: { cls: "rh-access__icon_unknown", hint: "неизвестно – проверка не удалась" },
};

/**
 * В4.7 (П3.2, П3.4): права зрителя — компонентами, а не глифами. В4.8: без
 * проверки строка молчит; путь «узнать» — пункт меню «Проверить доступ».
 * Круг 2 (2a): у приватного — серая метка видимости с замком.
 * Круг 3 (5a): три канала — ОДНОЙ плашкой с тремя иконками вместо трех
 * `Label`; расшифровка и дата проверки — в подсказке и `aria-label`.
 */
function AccessRights({ access, lastCheckedAt }: { access: import("../api/me").FavoriteEntry["access"]; lastCheckedAt: string | null }) {
  if (!access) return null;
  const checked = lastCheckedAt ? ` (проверено ${fmtDateTime(lastCheckedAt)})` : "";
  const channels = ACCESS_CHANNELS.map(({ key, title, icon }) => {
    const value = access[key];
    return { key, title, icon, state: ACCESS_STATES[value === true ? "yes" : value === false ? "no" : "unknown"] };
  });
  const summary = `Доступ: ${channels.map((c) => `${c.title} – ${c.state.hint}`).join(", ")}${checked}`;
  return (
    <Flex gap={1} alignItems="center" className="rh-repo-item__labels">
      {/* круг 4 (замечание 3): серая «пилюля», а не `Label theme="normal"` —
          в нашей палитре тот сопоставлен стальному misc и читался голубым */}
      {access.visibility === "private" && (
        <span className="rh-pill" title={`Приватный репозиторий${checked}`}>
          <Icon data={Lock} size={12} />
          Приватный
        </span>
      )}
      <span className="rh-pill rh-access" title={summary} aria-label={summary} role="img">
        {channels.map((c) => (
          <Icon key={c.key} data={c.icon} size={14} className={`rh-access__icon ${c.state.cls}`} />
        ))}
      </span>
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
