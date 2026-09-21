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
import { type MeResponse, type MetaResponse, type MyReposResponse, dataOf, logout, mutateJson, useJson, useLatest } from "./api";
import type { LiveAnalysis } from "./analysis";
import { announceJobsChanged, useAnalysis, useAnalysisFinished, useSession } from "./session";
import { authErrorText, favoriteAddedText, fmtDateTime, fmtScore, recommendationsText, scoreTheme, scoreWord, sentence, slugOf, type FavoriteAddCheck } from "./format";
import { TAB_RECOMMENDATIONS } from "./RepoPage";
import { type Band, BANDS, type RepoEntry, type SortKey, SORT_DEFAULT_DESC, SORT_OPTIONS, countBands, filterEntries, groupJobsByDay, sortEntries } from "./myRepos";
import { linkProps, navigate, repoHref } from "./router";
import { Page, UserAvatar, displayName, logoutFailedToast } from "./Shell";
import { AsideSection, EmptyState, LanguageName, Meta, MetaItem, PageHeader, RepoAvatar, RepoSlug, SkeletonRows } from "./ui";

const REPOS_CRUMBS = [{ text: "Мои репозитории" }];
const SETTINGS_CRUMBS = [{ text: "Настройки" }];

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

export function MePage(_props: { meta: MetaResponse | null }) {
  // В4.8.5 (К8.5.8): сессия — одно состояние приложения (session.tsx), а
  // не своя копия `/api/me` у каждой страницы; статусы анализа — из общего
  // опроса заданий вкладки (К8.5.1)
  const { me, reloadMe } = useSession();
  const data = dataOf(me);

  if (data === null && me.kind !== "error") {
    return (
      <Page crumbs={REPOS_CRUMBS}>
        <SkeletonRows rows={4} height={56} />
      </Page>
    );
  }
  if (data === null) {
    // В4.4 (кластер M-3): сбой /api/me — честная ошибка с повтором, не LoginOffer
    return (
      <Page crumbs={REPOS_CRUMBS}>
        <CabinetAlert title="Не удалось загрузить список репозиториев" message={me.kind === "error" ? me.message : undefined} actions={[{ text: "Повторить", handler: reloadMe }]} />
      </Page>
    );
  }
  if (data.login === null) {
    return <LoginOffer pageTitle="Мои репозитории" />;
  }
  return (
    // В4.8 (вариант A, решение 21.09): одна колонна — список, как у списков
    // SourceCraft. Журнал «Мои задания» из тела страницы убран: статус анализа
    // живет в строке, история — в «Заданиях» шапки (`JobsBell`). Правая
    // панель «Аккаунт» здесь дублировала аватар rail — осталась в Настройках.
    <Page crumbs={REPOS_CRUMBS}>
      {/* В4.4 (кластер I): список favorites-only живет и без PAT;
          токен нужен для проверки прав, автозапуска и посева из namespace */}
      <MyReposSection hasPat={data.hasPat} />
    </Page>
  );
}

export function SettingsPage() {
  const { me, reloadMe } = useSession();
  const data = dataOf(me);
  if (data === null && me.kind !== "error") {
    return (
      <Page crumbs={SETTINGS_CRUMBS}>
        <SkeletonRows rows={4} height={56} />
      </Page>
    );
  }
  if (data === null) {
    return (
      <Page crumbs={SETTINGS_CRUMBS}>
        <CabinetAlert title="Не удалось загрузить настройки" message={me.kind === "error" ? me.message : undefined} actions={[{ text: "Повторить", handler: reloadMe }]} />
      </Page>
    );
  }
  if (data.login === null) return <LoginOffer pageTitle="Настройки" />;
  return (
    <Page crumbs={SETTINGS_CRUMBS} aside={<AccountSection me={data} />}>
      {/* В4.8.5 (К8.5.3, С2-4): секция токена не перемонтируется по дате
          проверки — строка «Токен принадлежит…» после сохранения остаётся */}
      <PatSection hasPat={data.hasPat} unreadable={data.patUnreadable === true} checkedAt={data.patCheckedAt} onChanged={reloadMe} />
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
            : "Войдите через Я ID, чтобы следить за избранными репозиториями и запускать анализ своих."
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

function PatSection({ hasPat, unreadable = false, checkedAt, onChanged }: { hasPat: boolean; unreadable?: boolean; checkedAt: string | null; onChanged: () => void }) {
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
      setReplacing(false);
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
                проверен при сохранении {fmtDateTime(checkedAt)}
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
                {unreadable ? "Нужно сохранить заново" : "Не задан"}
              </Label>
              {/* В4.8.5 (К8.5.4, С2-5, С2-6): без жаргона и с причиной */}
              <Text variant="body-short" color="secondary">
                {unreadable
                  ? "сохраненный токен больше не читается после смены ключа сервиса"
                  : "закрытые данные и анализ своих репозиториев недоступны"}
              </Text>
            </Flex>
            <Text variant="body-short" color="complementary">
              SourceCraft: Домой → Доступ → Персональные токены доступа → Сгенерировать новый токен. Токен показывается один
              раз – скопируйте его сразу. Перед сохранением токен проверяется в SourceCraft: неверный токен не сохранится.
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


function MyReposSection({ hasPat }: { hasPat: boolean }) {
  // В4.8.5 (К8.5.3): перечитывание не мигает и не пропадает при сбое
  const repos = useJson<MyReposResponse>("/api/me/repos", { keepPrevious: true });
  const favs = useJson<FavoritesResponse>("/api/me/favorites", { keepPrevious: true });
  // С4-13: запуск на время отправки блокирует повторный клик по строке
  const [starting, setStarting] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState("");
  const [band, setBand] = useState<Band | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("index");
  const [sortDesc, setSortDesc] = useState(true);
  const toaster = useToaster();
  // В4.8.5 (К8.5.1): фаза анализа строки — из общего опроса заданий вкладки
  // (по заданию); тост об итоге даёт он же, из любого экрана
  const analysis = useAnalysis();
  const reposReloadRef = useRef(repos.reload);
  reposReloadRef.current = repos.reload;
  const listed = useLatest(repos.state.kind === "ok" ? repos.state.data.entries : []);
  // итог анализа пришёл — строка перечитывается (один раз на пачку итогов)
  useAnalysisFinished((jobs) => {
    if (jobs.some((j) => listed.current.some((e) => `${e.org}/${e.repo}` === j.slug))) reposReloadRef.current();
  });

  const startScan = useCallback(
    async (slug: string) => {
      if (starting.has(slug)) return;
      setStarting((prev) => new Set(prev).add(slug));
      try {
        const res = await mutateJson<{ deduplicated?: boolean }>(`/api/me/repos/${slug.split("/").map(encodeURIComponent).join("/")}/scan`, "POST");
        if (res?.deduplicated) toaster.add({ name: `scan-dedup:${slug}`, theme: "info", title: "Анализ уже идет", content: slug });
      } catch (e) {
        toaster.add({ name: `scan-failed:${slug}`, theme: "danger", title: "Анализ не запущен", content: e instanceof Error ? e.message : String(e) });
      } finally {
        setStarting((prev) => {
          const next = new Set(prev);
          next.delete(slug);
          return next;
        });
        // круг 4 (замечание 4) + С9-16: «Задания» и строка узнают о запуске сразу —
        // и тогда, когда ответ на запуск потерялся, а задание встало
        announceJobsChanged();
        analysis.refresh();
      }
    },
    [toaster, starting, analysis],
  );

  const removeFav = async (org: string, repo: string) => {
    setBusy(`${org}/${repo}`);
    try {
      await mutateJson(`/api/me/favorites/${encodeURIComponent(org)}/${encodeURIComponent(repo)}`, "DELETE");
      toaster.add({ name: `fav-removed:${org}/${repo}`, theme: "info", title: "Убрано из избранного", content: slugOf(org, repo) });
      // В4.8.5 (К8.5.7, §2-В3): после действия обновляется только строка —
      // список целиком не перечитывается (его окно — 30 чтений в минуту)
      const current = dataOf(repos.state);
      if (current) repos.set({ ...current, entries: current.entries.filter((e) => !(e.org === org && e.repo === repo)) });
      const currentFavs = dataOf(favs.state);
      if (currentFavs) favs.set({ entries: currentFavs.entries.filter((f) => !(f.org === org && f.repo === repo)) });
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

  const reposData = dataOf(repos.state);
  const entries = reposData?.entries ?? [];
  const accessBySlug = new Map((dataOf(favs.state)?.entries ?? []).map((f) => [`${f.org}/${f.repo}`, f]));
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
          message="С токеном сервис сам проверит ваши права на избранные репозитории, откроет анализ своих репозиториев и покажет CI/CD и Security на карточке. Токен добавляется в Настройках."
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
                    live={analysis.live(slug)}
                    starting={starting.has(slug)}
                    busy={busy !== null}
                    onScan={() => void startScan(slug)}
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
        onAdded={(res) => {
          setAdding(false);
          // К8.5.7: ответ добавления — обновлённая запись строки; список не перечитывается
          const current = dataOf(repos.state);
          if (current && res.entry) {
            const rest = current.entries.filter((e) => !(e.org === res.entry!.org && e.repo === res.entry!.repo));
            repos.set({ ...current, entries: [res.entry, ...rest] });
          } else {
            repos.reload();
          }
          const currentFavs = dataOf(favs.state);
          if (currentFavs && res.entry) {
            const key = (f: { org: string; repo: string }) => `${f.org}/${f.repo}`;
            const slug = key(res.entry);
            const others = currentFavs.entries.filter((f) => key(f) !== slug);
            favs.set({ entries: [{ org: res.entry.org, repo: res.entry.repo, addedAt: new Date().toISOString(), access: res.access ?? null, lastCheckedAt: res.lastCheckedAt ?? null, score: null }, ...others] });
          }
          // первый анализ своего мог встать — «Задания» и строка узнают сразу
          announceJobsChanged();
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
/** Ответ добавления в избранное (К8.5.7, К8.5.14): обновлённая запись строки и исход автопроверки прав. */
interface FavoriteAddResponse {
  entry?: import("../api/me").MyRepoEntry;
  access?: import("../api/me").FavoriteAccess | null;
  lastCheckedAt?: string | null;
  check?: FavoriteAddCheck;
}

function AddRepoDialog({ open, onClose, onAdded }: { open: boolean; onClose: () => void; onAdded: (res: FavoriteAddResponse) => void }) {
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
      const res = (await mutateJson<FavoriteAddResponse>("/api/me/favorites", "PUT", { repository: value })) ?? {};
      // В4.8.5 (К8.5.14 (д)): права проверены сами — тост говорит, чем кончилось
      toaster.add({ name: "fav-added", theme: "success", title: "Добавлено в избранное", content: `${value}. ${favoriteAddedText(res.check)}` });
      setValue("");
      onAdded(res);
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
  live,
  starting,
  busy,
  onScan,
  onRemove,
}: {
  entry: RepoEntry;
  access: import("../api/me").FavoriteAccess | null;
  lastCheckedAt: string | null;
  hasPat: boolean;
  /** В4.8.5 (К8.5.1): живое задание зрителя по этому репозиторию — из общего опроса вкладки */
  live: LiveAnalysis | null;
  /** запуск отправляется (повторный клик заблокирован, С4-13) */
  starting: boolean;
  busy: boolean;
  onScan: () => void;
  onRemove: () => void;
}) {
  const { org, repo } = entry;
  const href = repoHref(org, repo);
  const scored = entry.healthcraftIndex !== null;
  const inWork = live !== null || starting;
  const canAnalyze = hasPat && access?.own === true;
  // В4.8.5 (К8.5.1, К8.5.2b): фаза — по заданию; «затянулось» — признак сервера
  const phase = live === null ? null : live.stalled ? "stalled" : live.phase;

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
      // §2-В5: «идет анализ» — без обещания времени
      <span className="rh-state rh-busy" title="Идет анализ – итог придет уведомлением">
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
      <span className="rh-state rh-busy" title="Идет анализ">
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
      // В4.8.5 (К8.5.9, С3-3): речь о каталоге СЕРВИСА — репозиторий на
      // SourceCraft может быть, у нас его ещё не анализировали
      <StatePill icon={CircleQuestion} title="Репозитория пока нет в каталоге сервиса: его еще не анализировали, или адрес указан с ошибкой">
        Нет в каталоге
      </StatePill>
    ) : !entry.mayRead ? (
      <StatePill icon={Lock} title="Ваш токен не дает доступа к данным этого репозитория">
        Нет прав
      </StatePill>
    ) : (
      <StatePill icon={CircleDashed} title="Анализ этого репозитория еще не запускали">
        Еще не анализировали
      </StatePill>
    );

  // В4.8.5 (К8.5.14 (г), §2-В1): пункта ручной проверки прав нет — права
  // проверяются сами при добавлении, после смены токена и фоном
  const menuItems = [
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
        {/* В4.8.5 (К8.5.14 (в)): кнопка анализа — только на СВОЕМ репозитории
            (сохранённая проверка прав: own); у чужого и непроверенного её нет
            вовсе — элемента нет, а не неактивен */}
        {!canAnalyze ? null : scored ? (
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

// В4.8.5 (К8.5.1): свой опрос `/api/me/jobs` у страницы и у «Заданий» шапки
// убран — один опрос на вкладку живёт в session.tsx (пауза в скрытой
// вкладке, 401 переводит приложение в «вы вышли», К8.5.8); событие
// «задания изменились» — там же (`announceJobsChanged`).

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
/** С9-13: опрос заданий не удался — список мог устареть (сбой не молчит) */
export const JOBS_STALE_TEXT = "Не удалось обновить задания – список мог устареть, повторим автоматически.";

export function JobsBell() {
  const { jobs, failing } = useAnalysis();
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
        title={failing ? JOBS_STALE_TEXT : busy ? "Ваши анализы идут" : alarm ? "Последний анализ завершился ошибкой" : "Ваши анализы"}
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
          {failing && (
            <Text as="div" variant="caption-2" color="secondary">
              {JOBS_STALE_TEXT}
            </Text>
          )}
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
  // В4.8.5 (К8.5.6, С4-12): отказом считается только вердикт о правах (сбой SourceCraft запуск не отклоняет)
  refused: { icon: CircleExclamation, cls: "rh-state__icon", text: "Не запущен: нет прав на анализ этого репозитория" },
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
 * проверки строка молчит. В4.8.5 (К8.5.14): права проверяются сами — ручного пункта нет.
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
