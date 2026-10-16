// Страницы пользователя: «Избранное» (/me), «Настройки» (/settings) и панель
// «Задания» в шапке. Избранное — один список, где в строке сразу видимость,
// статус анализа и действия. Токен SourceCraft задается в Настройках: вставка →
// живая проверка → зашифрованное хранение. API токен никогда не возвращает и не логирует.
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
  Ellipsis,
  Flag,
  Hourglass,
  Key,
  ListCheck,
  Lock,
  Magnifier,
  OctagonXmark,
  Person,
  Plus,
  Star,
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
import { announceJobStarted, announceJobsChanged, useAnalysis, useAnalysisFinished, useSession } from "./session";
import { plural } from "../report/submetrics";
import { FRAUD_EXPLAIN, FRAUD_TITLE, authErrorText, failedAnalysisHint, favoriteAddedText, fmtDateTime, fmtScore, quotaCell, recommendationsText, scoreLabelTheme, scoreTheme, scoreWord, sentence, slugOf, type ActionQuotaView, type AiQuotaView, type FavoriteAddCheck, type QuotaWindowView } from "./format";
import { recommendationsHref } from "./RepoPage";
import { type Band, BANDS, type RepoEntry, type SortKey, SORT_DEFAULT_DESC, SORT_OPTIONS, countBands, filterEntries, groupJobsByDay, sortEntries } from "./myRepos";
import { linkProps, navigate, repoHref } from "./router";
import { Page, UserAvatar, displayName, logoutFailedToast } from "./Shell";
import { AsideSection, EmptyState, LanguageName, Meta, MetaItem, PageHeader, RepoAvatar, RepoSlug, ScoreBar, SkeletonRows, TIP_TARGET, VisibilityPill } from "./ui";

const REPOS_CRUMBS = [{ text: "Избранное" }];
const SETTINGS_CRUMBS = [{ text: "Настройки" }];

/** Название раздела SourceCraft в инструкции — серым тегом. */
function UiTag({ children }: { children: ReactNode }) {
  return (
    <Label theme="unknown" size="xs" className="rh-ui-tag">
      {children}
    </Label>
  );
}

/** Инструкция SourceCraft по персональному токену. */
const PAT_DOCS_URL = "https://sourcecraft.dev/portal/docs/ru/sourcecraft/security/pat";

/** Общая плашка ошибок и подсказок страниц: вид и размер одни на всех, тема — по смыслу. */
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

/** Предупреждение «нет токена» со ссылкой в Настройки; с токеном не показывается. */
function TokenNotice({ hasPat }: { hasPat: boolean }) {
  if (hasPat) return null;
  return (
    <Alert
      theme="info"
      view="filled"
      className="rh-token-notice"
      icon={<Icon data={Key} size={18} className="rh-info-icon" />}
      title="Добавьте персональный токен доступа SourceCraft"
      message="С ним откроются CI/CD, Безопасность и анализ своих репозиториев."
      actions={
        // обертка — чтобы кнопка была по ширине текста, а не во всю плашку
        <span className="rh-token-notice__action">
          <Button view="normal" size="m" {...linkProps("/settings")}>
            Перейти в Настройки
          </Button>
        </span>
      }
    />
  );
}

export function MePage(_props: { meta: MetaResponse | null }) {
  // сессия — общее состояние приложения (session.tsx), а не своя копия /api/me у страницы
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
    // сбой /api/me — ошибка с повтором, а не предложение войти
    return (
      <Page crumbs={REPOS_CRUMBS}>
        <CabinetAlert title="Не удалось загрузить список репозиториев" message={me.kind === "error" ? me.message : undefined} actions={[{ text: "Повторить", handler: reloadMe }]} />
      </Page>
    );
  }
  if (data.login === null) {
    return <LoginOffer pageTitle="Избранное" />;
  }
  return (
    // одна колонка без боковой панели: статус анализа — в строке, история — в
    // «Заданиях» шапки (JobsBell), аккаунт — в Настройках
    <Page crumbs={REPOS_CRUMBS}>
      {/* список работает и без токена; токен нужен для проверки прав, автозапуска
          анализа и добавления репозиториев из пространства SourceCraft */}
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
    <Page
      crumbs={SETTINGS_CRUMBS}
      aside={
        <>
          <AccountSection me={data} />
          {/* «только для чтения» верно: запросов на запись к SourceCraft в коде нет */}
          <AsideSection title="Зачем токен">
            <Text color="complementary">Нужен, чтобы видеть CI/CD и Безопасность своих репозиториев. Используется только для чтения.</Text>
          </AsideSection>
        </>
      }
    >
      {/* у PatSection нет key по дате проверки: иначе она перемонтируется и
          строка «Токен принадлежит…» пропадет сразу после сохранения */}
      <Flex direction="column" gap={4}>
        <PatSection hasPat={data.hasPat} unreadable={data.patUnreadable === true} checkedAt={data.patCheckedAt} onChanged={reloadMe} />
        <AiLimitsSections />
      </Flex>
    </Page>
  );
}
/** Остаток лимитов AI в той же форме «N/M», что на кнопках карточки репозитория. */
function AiQuotaTable({ data }: { data: AiQuotaView }) {
  const cell = (w: QuotaWindowView | null, none: string): string => (w === null ? none : quotaCell(w));
  const rows: { title: string; q: ActionQuotaView }[] = [
    { title: "AI-обзоры", q: data.overview },
    { title: "Проверки оценки", q: data.check },
  ];
  const head = (text: string) => (
    <th scope="col">
      <Text variant="caption-2" color="secondary">
        {text}
      </Text>
    </th>
  );
  return (
    <div className="rh-ai-quota-box">
    <table className="rh-ai-quota">
      <thead>
        <tr>
          <th scope="col" aria-label="Действие" />
          {head("За час")}
          {head("За сутки")}
          {head(data.unlocked ? "Потолок по паролю за сутки" : "Сервис за сутки")}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.title}>
            <th scope="row">
              <Text variant="body-short">{r.title}</Text>
            </th>
            <td>
              <Text variant="body-short">{cell(r.q.hour, "без лимита")}</Text>
            </td>
            <td>
              <Text variant="body-short">{cell(r.q.day, "без лимита")}</Text>
            </td>
            <td>
              <Text variant="body-short">{cell(r.q.global, "без потолка")}</Text>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
    </div>
  );
}

/**
 * Карточки «Лимиты AI» и «Доступ без лимитов». Лимиты видит каждый вошедший;
 * карточка пароля — только если пароль настроен на сервере.
 */
function AiLimitsSections() {
  const quota = useJson<AiQuotaView>("/api/me/ai-quota");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toaster = useToaster();
  const data = dataOf(quota.state);
  if (data === null) return null;

  async function unlock() {
    setBusy(true);
    setError(null);
    try {
      await mutateJson<{ ok: boolean }>("/api/me/ai-unlock", "POST", { password });
      setPassword("");
      toaster.add({ name: "ai-unlocked", theme: "success", title: "Доступ без лимитов включен", content: "AI-обзоры и проверки оценки больше не ограничены личными лимитами." });
      quota.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function lock() {
    setBusy(true);
    try {
      await mutateJson<{ ok: boolean }>("/api/me/ai-unlock", "DELETE");
      quota.reload();
    } catch (e) {
      toaster.add({ name: "ai-lock-fail", theme: "danger", title: "Доступ не отключен", content: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Card view="outlined" className="rh-settings-card">
        <Flex as="section" direction="column" gap={3}>
          <Text variant="subheader-2" as="h2">
            Лимиты AI
          </Text>
          <Text variant="body-short" color="secondary">
            Сколько AI-обзоров и проверок оценки еще можно запустить. Сутки считаются с 00:00 по московскому времени.
          </Text>
          <AiQuotaTable data={data} />
        </Flex>
      </Card>
      {data.unlockAvailable && (
        <Card view="outlined" className="rh-settings-card">
          <Flex as="section" direction="column" gap={3}>
            <Flex gap={2} alignItems="center" wrap>
              <Text variant="subheader-2" as="h2">
                Доступ без лимитов
              </Text>
              {data.unlocked ? (
                <Label theme="success" size="xs">
                  Включен
                </Label>
              ) : (
                <Label theme="unknown" size="xs">
                  Не включен
                </Label>
              )}
            </Flex>
            <Text variant="body-short" color="secondary">
              {data.unlocked
                ? "AI-обзоры и проверки оценки не ограничены личными лимитами."
                : "Пароль выдает администратор сервиса. Он снимает личные лимиты AI."}
            </Text>
            {data.unlocked ? (
              <Flex gap={2}>
                <Button view="normal" size="m" onClick={() => void lock()} loading={busy}>
                  Отключить
                </Button>
              </Flex>
            ) : (
              <Flex gap={2} alignItems="center" className="rh-inline-form">
                <TextInput
                  className="rh-grow"
                  type="password"
                  size="m"
                  placeholder="Пароль доступа"
                  value={password}
                  onUpdate={setPassword}
                  hasClear
                  autoComplete="off"
                  controlProps={{ "aria-label": "Пароль доступа к AI без лимитов" }}
                />
                <Button view="action" size="m" onClick={() => void unlock()} loading={busy} disabled={busy || password.length === 0}>
                  Включить
                </Button>
              </Flex>
            )}
            {error && (
              <Text color="danger" variant="body-short">
                {error}
              </Text>
            )}
          </Flex>
        </Card>
      )}
    </>
  );
}


/**
 * «Аккаунт» — кто вошел и выход. Здесь выход доступен всегда, в том числе при
 * узком rail, где у аватара кнопки нет.
 */
function AccountSection({ me }: { me: MeResponse }) {
  const toaster = useToaster();
  const name = displayName(me);
  return (
    <AsideSection title="Аккаунт">
      <div className="rh-account">
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
      {/* «Выйти» — шириной блока аккаунта: без обертки rh-account колонка панели
          (align-items: stretch) растянула бы кнопку во всю ширину */}
        <Button view="outlined" size="m" width="max" onClick={() => void logout().catch((e: unknown) => toaster.add(logoutFailedToast(e)))}>
          <Icon data={ArrowRightFromSquare} size={16} />
          Выйти
        </Button>
      </div>
    </AsideSection>
  );
}

/** Не вошедшему — что доступно без входа и кнопка входа. */
function LoginOffer({ pageTitle }: { pageTitle: "Избранное" | "Настройки" }) {
  // после неудачного callback Я ID сервер возвращает на /me?auth_error=… — причину показываем
  const authError = new URLSearchParams(window.location.search).get("auth_error");
  return (
    <Page
      crumbs={[{ text: pageTitle }]}
      aside={
        <AsideSection title="Как это устроено">
          <Text color="complementary">
            Публичный рейтинг работает и без входа – раздел «Рейтинг». Блоки CI/CD и Безопасность на карточке репозитория
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
        title={pageTitle === "Настройки" ? "Настройки доступны после входа" : "Избранное доступно после входа"}
        description={
          pageTitle === "Настройки"
            ? "Войдите через Я ID, чтобы настроить персональный токен доступа SourceCraft."
            : "Войдите через Я ID, чтобы следить за избранными репозиториями и запускать анализ собственных."
        }
        actions={[{ text: "Войти через Я ID", view: "action", size: "l", href: "/auth/ya" }]}
      />
    </Page>
  );
}

// ---------- токен: PUT проверяет его в SourceCraft и сохраняет, DELETE удаляет ----------

/** Итог добавления репозиториев из пространства SourceCraft в избранное — строкой для тоста. */
function seedNote(seed: import("../api/me").PatSeed | undefined): string {
  if (seed === undefined) return "Репозитории вашего пространства SourceCraft в избранное не добавлялись.";
  if (seed.status === "ok")
    return seed.added > 0
      ? `Из вашего пространства SourceCraft в избранное ${plural(seed.added, "добавлен", "добавлено", "добавлено")} ${seed.added} ${plural(seed.added, "репозиторий", "репозитория", "репозиториев")}.`
      : "Новых репозиториев из вашего пространства SourceCraft для избранного нет.";
  const why =
    seed.error?.code === "favorite_limit"
      ? "достигнут предел избранного"
      : seed.error?.code === "page_limit"
        ? "прочитаны не все страницы пространства"
        : seed.error?.code === "no_username"
          ? // пространство даже не опрашивалось — причина не в нем
            "SourceCraft не вернул имя пользователя"
          : "SourceCraft ответил сбоем";
  return `Добавление репозиториев вашего пространства SourceCraft в избранное остановлено: ${why} (добавлено ${seed.added}).`;
}

function PatSection({ hasPat, unreadable = false, checkedAt, onChanged }: { hasPat: boolean; unreadable?: boolean; checkedAt: string | null; onChanged: () => void }) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [owner, setOwner] = useState<string | null>(null);
  const [replacing, setReplacing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // заголовок ошибки зависит от операции: сохранение или удаление
  const [failedOp, setFailedOp] = useState<"save" | "remove">("save");
  const toaster = useToaster();

  async function save() {
    setBusy(true);
    setError(null);
    setFailedOp("save");
    try {
      // ответ несет и итог добавления репозиториев из пространства — он уходит в тост
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
    // поле и кнопка в ряд; на телефоне столбиком, иначе поле сжимается до «Персона…»
    <Flex gap={2} alignItems="center" className="rh-inline-form">
      <TextInput
        className="rh-grow"
        type="password"
        size="m"
        placeholder={label}
        value={token}
        onUpdate={setToken}
        hasClear
        autoComplete="off"
        controlProps={{ "aria-label": label }}
      />
      <Button view="action" size="m" onClick={save} loading={busy} disabled={busy || token.length < 8}>
        {submit}
      </Button>
    </Flex>
  );

  return (
    <Card view="outlined" className="rh-settings-card">
      <Flex as="section" direction="column" gap={3}>
        <Text variant="subheader-2" as="h2">
          Персональный токен доступа SourceCraft
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
                {tokenForm("Новый персональный токен доступа", "Проверить и заменить")}
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
              <Text variant="body-short" color="secondary">
                {unreadable
                  ? "сохраненный токен больше не читается после смены ключа сервиса"
                  : "закрытые данные и анализ своих репозиториев недоступны"}
              </Text>
            </Flex>
            {tokenForm("Персональный токен доступа SourceCraft", "Проверить и сохранить")}
            {/* инструкция шагами, как в документации SourceCraft; полная — по ссылке */}
            <Flex direction="column" gap={2} className="rh-howto-box">
              <Flex gap={2} alignItems="baseline" wrap>
                <Text variant="subheader-1">Как получить токен?</Text>
                <Link href={PAT_DOCS_URL} target="_blank" rel="noopener noreferrer">
                  Инструкция SourceCraft
                </Link>
              </Flex>
              <ol className="rh-howto">
                <li>
                  В SourceCraft нажмите <UiTag>Домой</UiTag> и откройте <UiTag>Доступ</UiTag> → <UiTag>Персональные токены доступа</UiTag>.
                </li>
                <li>
                  Нажмите <UiTag>+ Новый токен</UiTag>. В поле <UiTag>Доступ к репозиторию</UiTag> выберите{" "}
                  <UiTag>Все права учетной записи</UiTag> – подойдет и <UiTag>Все репозитории</UiTag>.
                </li>
                <li>Скопируйте токен и вставьте его в поле выше.</li>
              </ol>
              <Alert theme="warning" view="filled" size="s" message="Токен показывается один раз. Перед сохранением мы проверим его в SourceCraft." />
            </Flex>
          </Flex>
        )}
        {error && (
          <CabinetAlert title={failedOp === "save" ? "Токен не сохранен" : "Токен не удален"} message={error} />
        )}

        <Dialog open={confirmDelete} onClose={() => setConfirmDelete(false)} maxWidth="s" fullWidth className="rh-dialog-fit" aria-label="Удаление токена">
          <Dialog.Header caption="Удалить токен?" />
          <Dialog.Body>
            <Text>CI/CD, Безопасность и запуск анализа своих репозиториев станут недоступны, пока вы не добавите новый токен.</Text>
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

// ---------- избранное ----------

/** Грубая клиентская проверка ручного ввода: org/repo или http(s)-ссылка; точный разбор — на сервере. */
const INPUT_LIKELY = /^([a-z0-9_.-]+\/[a-z0-9_.-]+|https?:\/\/\S+)$/i;


function MyReposSection({ hasPat }: { hasPat: boolean }) {
  // keepPrevious: при перечитывании и сбое список не мигает и не пропадает
  const repos = useJson<MyReposResponse>("/api/me/repos", { keepPrevious: true });
  const favs = useJson<FavoritesResponse>("/api/me/favorites", { keepPrevious: true });
  // слаги, чей запуск еще отправляется: повторный клик по строке блокируется
  const [starting, setStarting] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState("");
  const [band, setBand] = useState<Band | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("index");
  const [sortDesc, setSortDesc] = useState(true);
  const toaster = useToaster();
  // фаза анализа строки — из общего опроса заданий вкладки; тост об итоге
  // показывает он же, на любом экране
  const analysis = useAnalysis();
  const reposReloadRef = useRef(repos.reload);
  reposReloadRef.current = repos.reload;
  const listed = useLatest(repos.state.kind === "ok" ? repos.state.data.entries : []);
  // пришел итог анализа по репозиторию из списка — список перечитывается (один раз на пачку итогов)
  useAnalysisFinished((jobs) => {
    if (jobs.some((j) => listed.current.some((e) => `${e.org}/${e.repo}` === j.slug))) reposReloadRef.current();
  });

  const startScan = useCallback(
    async (slug: string) => {
      if (starting.has(slug)) return;
      setStarting((prev) => new Set(prev).add(slug));
      try {
        const res = await mutateJson<{ deduplicated?: boolean; jobId?: number }>(`/api/me/repos/${slug.split("/").map(encodeURIComponent).join("/")}/scan`, "POST");
        // итог задания объявится, даже если придет в первом ответе опроса (базовой линии)
        announceJobStarted(res?.jobId);
        if (res?.deduplicated) toaster.add({ name: `scan-dedup:${slug}`, theme: "info", title: "Анализ уже идет", content: slug });
      } catch (e) {
        toaster.add({ name: `scan-failed:${slug}`, theme: "danger", title: "Анализ не запущен", content: e instanceof Error ? e.message : String(e) });
      } finally {
        setStarting((prev) => {
          const next = new Set(prev);
          next.delete(slug);
          return next;
        });
        // «Задания» и строка узнают о запуске сразу — даже если ответ на запуск
        // потерялся, а задание в очередь встало
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
      // обновляется только строка: список целиком не перечитывается, у него
      // лимит 30 чтений в минуту
      const current = dataOf(repos.state);
      if (current) repos.set({ ...current, entries: current.entries.filter((e) => !(e.org === org && e.repo === repo)) });
      const currentFavs = dataOf(favs.state);
      if (currentFavs) favs.set({ entries: currentFavs.entries.filter((f) => !(f.org === org && f.repo === repo)) });
    } catch (e) {
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
      {/* шапка списка по образцу SourceCraft («Active issues 39»): заголовок,
          счетчик, справа поиск, сортировка и единственная action-кнопка страницы */}
      <div className="rh-me-head">
        <Flex direction="column" className="rh-me-head__title rh-page-head">
          <Flex gap={2} alignItems="baseline">
            <Text variant="header-2" as="h1" className="rh-page-title">
              Избранное
            </Text>
            {repos.state.kind === "ok" && (
              <Text variant="header-2" color="secondary" className="rh-page-title">
                {entries.length}
              </Text>
            )}
          </Flex>
          <Text variant="body-2" color="complementary">
            Следите за здоровьем избранных репозиториев и тем, что возможно в них улучшить.
          </Text>
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

      <TokenNotice hasPat={hasPat} />

      {repos.state.kind === "loading" && <SkeletonRows rows={3} height={66} />}
      {repos.state.kind === "error" && (
        <CabinetAlert title="Не удалось загрузить список" message={repos.state.message} actions={[{ text: "Повторить", handler: repos.reload }]} />
      )}
      {favs.state.kind === "error" && (
        <CabinetAlert title="Не удалось загрузить избранное" message={favs.state.message} actions={[{ text: "Повторить", handler: favs.reload }]} />
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
          {/* сводка по полосам шкалы — она же фильтр; повторный клик по плитке
              снимает фильтр. Цвет полосы — только у иконки в углу плитки */}
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
                    // Card type="selection" ставит role="radio" и aria-checked, но плитка —
                    // переключатель (повторный клик снимает фильтр): роль кнопки и aria-pressed
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
        hasPat={hasPat}
        favorites={new Set((dataOf(favs.state)?.entries ?? []).map((f) => `${f.org}/${f.repo}`.toLowerCase()))}
        onClose={() => setAdding(false)}
        onAdded={(res) => {
          // окно остается открытым — можно добавить несколько. Ответ несет готовую
          // запись строки, поэтому список не перечитывается
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

/** Иконка полосы на плитке сводки; у «Без оценки» иконки нет — это не полоса шкалы. */
const BAND_ICON: Record<Band, IconData | null> = {
  success: CircleCheck,
  warning: TriangleExclamation,
  danger: OctagonXmark,
  none: null,
};

/** Серая плашка состояния строки: смысл — иконкой и подсказкой, цвет только у иконки. */
function StatePill({ icon, tone, title, children }: { icon: IconData; tone?: "danger" | "warning"; title: string; children: ReactNode }) {
  return (
    <span className="rh-state" title={title}>
      <Icon data={icon} size={14} className={tone ? `rh-state__icon rh-state__icon_${tone}` : "rh-state__icon"} />
      {children}
    </span>
  );
}

/** Ответ добавления в избранное: обновленная запись строки и итог автопроверки прав. */
interface FavoriteAddResponse {
  entry?: import("../api/me").MyRepoEntry;
  access?: import("../api/me").FavoriteAccess | null;
  lastCheckedAt?: string | null;
  check?: FavoriteAddCheck;
}

/** Репозиторий, доступный токену зрителя (/me/repos по PAT; не «свой» — признака владения в ответе нет). */
interface ScRepoLite {
  org: string;
  slug: string;
  name: string | null;
  visibility: string | null;
  isEmpty: boolean;
}

type ScListState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; message: string; retry: boolean }
  | { kind: "ok"; repos: ScRepoLite[]; partial: boolean };

function useScRepos(enabled: boolean): { state: ScListState; reload: () => void } {
  const [state, setState] = useState<ScListState>({ kind: enabled ? "loading" : "idle" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const ctrl = new AbortController();
    setState({ kind: "loading" });
    fetch("/api/me/sourcecraft-repos", { signal: ctrl.signal })
      .then(async (res) => {
        const body = (await res.json().catch(() => null)) as { repos?: ScRepoLite[]; partial?: boolean; error?: { code?: string; message?: string } } | null;
        if (!res.ok) {
          // текст ошибки — по коду; при лимите запросов — с временем повтора
          const retryAfter = Number(res.headers.get("retry-after"));
          setState({
            kind: "error",
            retry: true,
            message:
              res.status === 429
                ? `Список обновляли слишком часто – повторите${Number.isFinite(retryAfter) && retryAfter > 0 ? ` через ${Math.ceil(retryAfter)} с` : " позже"}`
                : body?.error?.code === "source_http"
                  ? "SourceCraft не ответил"
                  : "Список недоступен",
          });
          return;
        }
        setState({ kind: "ok", repos: body?.repos ?? [], partial: body?.partial === true });
      })
      .catch(() => {
        if (!ctrl.signal.aborted) setState({ kind: "error", message: "Список недоступен", retry: true });
      });
    return () => ctrl.abort();
  }, [enabled, attempt]);
  return { state, reload: () => setAttempt((n) => n + 1) };
}

/**
 * Окно добавления в избранное. Одно поле — и поиск по репозиториям, доступным
 * токену, и ввод org/repo или ссылки (точный разбор — на сервере). Уже
 * добавленные помечены «В избранном»; окно не закрывается после добавления.
 */
function AddRepoDialog({
  open,
  onClose,
  onAdded,
  hasPat,
  favorites,
}: {
  open: boolean;
  onClose: () => void;
  onAdded: (res: FavoriteAddResponse) => void;
  hasPat: boolean;
  favorites: ReadonlySet<string>;
}) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<ReadonlySet<string>>(new Set());
  const toaster = useToaster();
  const inputRef = useRef<HTMLInputElement>(null);
  const list = useScRepos(open && hasPat);

  const inFav = (slug: string): boolean => favorites.has(slug.toLowerCase()) || added.has(slug.toLowerCase());
  const close = () => {
    setValue("");
    setError(null);
    setAdded(new Set());
    onClose();
  };

  const add = async (repository: string) => {
    if (inFav(repository)) {
      toaster.add({ name: `fav-exists:${repository}`, theme: "info", title: "Уже в избранном", content: repository });
      return;
    }
    setBusy(repository);
    setError(null);
    try {
      const res = (await mutateJson<FavoriteAddResponse>("/api/me/favorites", "PUT", { repository })) ?? {};
      const slug = res.entry ? `${res.entry.org}/${res.entry.repo}` : repository;
      // права проверяются сервером при добавлении — тост говорит, чем кончилось
      toaster.add({ name: `fav-added:${slug}`, theme: "success", title: "Добавлено в избранное", content: `${slug}. ${favoriteAddedText(res.check, res.access?.visibility)}` });
      setAdded((prev) => new Set(prev).add(slug.toLowerCase()).add(repository.toLowerCase()));
      if (repository === value) setValue("");
      onAdded(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const q = value.trim().toLowerCase();
  const repos = list.state.kind === "ok" ? list.state.repos : [];
  const shown = q === "" ? repos : repos.filter((r) => `${r.org}/${r.slug}`.toLowerCase().includes(q) || (r.name ?? "").toLowerCase().includes(q));
  // ручной ввод: похоже на org/repo или ссылку и не совпало со строкой списка — строка «Добавить …»
  const manual = INPUT_LIKELY.test(value.trim()) && !repos.some((r) => `${r.org}/${r.slug}`.toLowerCase() === q) ? value.trim() : null;

  const onEnter = () => {
    if (busy) return;
    if (manual) return void add(manual);
    if (shown.length === 1) return void add(`${shown[0]!.org}/${shown[0]!.slug}`);
    // формат проверяется по Enter, а не на каждом нажатии
    if (value.trim() !== "") setError("Нужен вид org/repo или ссылка на репозиторий");
  };

  const row = (key: string, label: ReactNode, slug: string, meta: ReactNode) => {
    const has = inFav(slug);
    return (
      <li key={key} className="rh-add-row">
        <RepoAvatar repo={slug.split("/")[1] ?? slug} logoUrl={null} size="s" />
        <span className="rh-add-row__main">
          <span className="rh-add-row__slug" title={slug}>
            {label}
          </span>
          {meta}
        </span>
        {has ? (
          <Label theme="success" size="xs" icon={<Icon data={CircleCheck} size={12} />}>
            В избранном
          </Label>
        ) : (
          <Button view="flat" size="m" loading={busy === slug} disabled={busy !== null && busy !== slug} onClick={() => void add(slug)} aria-label={`Добавить ${slug}`}>
            <Icon data={Plus} size={16} />
          </Button>
        )}
      </li>
    );
  };

  return (
    // maxWidth + fullWidth вместо устаревшего size: окно ужимается по экрану телефона
    <Dialog open={open} onClose={close} maxWidth="s" fullWidth className="rh-dialog-fit" aria-label="Добавить в избранное" initialFocus={inputRef}>
      <Dialog.Header caption="Добавить в избранное" />
      <Dialog.Body>
        <Flex direction="column" gap={2} className="rh-add-repo">
          <TextInput
            size="l"
            controlRef={inputRef}
            placeholder={hasPat ? "Найдите репозиторий или вставьте ссылку" : "org/repo или ссылка на репозиторий"}
            value={value}
            startContent={<Icon data={Magnifier} size={16} className="rh-add-repo__lens" />}
            onUpdate={(v) => {
              setValue(v);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") onEnter();
            }}
            hasClear
            controlProps={{ "aria-label": "Поиск репозитория, org/repo или ссылка" }}
            errorPlacement="outside"
            validationState={error ? "invalid" : undefined}
            errorMessage={error ?? undefined}
          />
          {hasPat ? (
            <Text variant="body-1" color="secondary">
              Доступны вашему токену в SourceCraft
            </Text>
          ) : (
            <Text variant="body-1" color="complementary">
              {"Добавьте токен в "}
              <Link {...linkProps("/settings")}>Настройках</Link>
              {" – тогда здесь появятся репозитории, доступные вашему токену. Пока можно вставить org/repo или ссылку."}
            </Text>
          )}
          <ul className="rh-add-list" aria-label="Репозитории">
            {manual !== null && row(`manual:${manual}`, <>Добавить <b>{manual}</b></>, manual, null)}
            {list.state.kind === "loading" && <SkeletonRows rows={4} height={40} />}
            {shown.map((r) => {
              const slug = `${r.org}/${r.slug}`;
              return row(
                slug,
                <RepoSlug org={r.org} repo={r.slug} variant="body-1" />,
                slug,
                <span className="rh-add-row__meta">
                  <VisibilityPill value={r.visibility} />
                  {r.isEmpty && (
                    <Label theme="normal" size="xs">
                      пустой
                    </Label>
                  )}
                </span>,
              );
            })}
          </ul>
          {list.state.kind === "error" && (
            <Flex gap={2} alignItems="center" wrap>
              <Text variant="body-1" color="complementary">
                {list.state.message}
              </Text>
              {list.state.retry && (
                <Button view="outlined" size="s" onClick={list.reload}>
                  Повторить
                </Button>
              )}
            </Flex>
          )}
          {list.state.kind === "ok" && repos.length === 0 && (
            <Text variant="body-1" color="complementary">
              SourceCraft не вернул ни одного репозитория – вставьте org/repo или ссылку.
            </Text>
          )}
          {list.state.kind === "ok" && repos.length > 0 && q !== "" && shown.length === 0 && manual === null && (
            <Text variant="body-1" color="complementary">
              {`Среди ${repos.length} загруженных нет «${value.trim()}» – вставьте org/repo целиком.`}
            </Text>
          )}
          {list.state.kind === "ok" && list.state.partial && (
            <Text variant="body-1" color="secondary">
              {addListPartialText(repos.length)}
            </Text>
          )}
        </Flex>
      </Dialog.Body>
      <Dialog.Footer textButtonApply="Готово" onClickButtonApply={close} />
    </Dialog>
  );
}

/** Подпись неполного списка (прочитаны не все страницы SourceCraft): остальное — ручным вводом. */
export function addListPartialText(count: number): string {
  return `Показано ${count} – остальные найдутся по org/repo`;
}

/**
 * Строка репозитория по образцу `ListingItem` SourceCraft. Строка целиком
 * ведет в карточку (слой-ссылка под содержимым), интерактивные элементы стоят
 * над ним. Справа — оценка или состояние анализа, затем кнопка и меню действий.
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
  /** живое задание зрителя по этому репозиторию — из общего опроса вкладки */
  live: LiveAnalysis | null;
  /** запуск отправляется — повторный клик заблокирован */
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
  // «затянулось» решает сервер (истек срок захвата задания), а не таймер в браузере
  const phase = live === null ? null : live.stalled ? "stalled" : live.phase;

  // все состояния без оценки — одна серая StatePill: цветные Label читались
  // тегами, поэтому цвет только у иконки и только там, где он что-то значит
  const state =
    phase === "stalled" ? (
      <StatePill icon={Hourglass} tone="warning" title="Анализ идет дольше обычного – его исход появится в «Заданиях» в шапке">
        Затянулось
      </StatePill>
    ) : phase !== null ? (
      // бегущая штриховка — то же состояние загрузки, что у кнопок Gravity;
      // время анализа сознательно не обещаем
      <span className="rh-state rh-busy" title="Идет анализ – итог придет уведомлением">
        {phase === "queued" ? "В очереди" : "Идет анализ"}
      </span>
    ) : entry.planned ? (
      // «данных пока нет» — не то же, что «данных не будет»; мета и оценка
      // при этом скрыты (fail-closed)
      <StatePill icon={Clock} title="Анализ запланирован">
        Запланирован
      </StatePill>
    ) : scored ? (
      <div className="rh-repo-item__score" title="HealthCraft Index – публичная оценка репозитория">
        {/* слот плашки фиксированной ширины прижимает ее к полосе: полосы и числа
            всех строк стоят друг под другом, какой бы длины ни было слово уровня */}
        <span className="rh-repo-item__level">
          <Label theme={scoreLabelTheme(entry.healthcraftIndex)} size="s">
            {sentence(scoreWord(entry.healthcraftIndex))}
          </Label>
        </span>
        {/* та же полоса, что в рейтинге и на карточке, — вместо кольца */}
        <ScoreBar value={entry.healthcraftIndex!} width={64} />
        <Text variant="subheader-2" className="rh-repo-item__num">
          {fmtScore(entry.healthcraftIndex!)}
        </Text>
      </div>
    ) : entry.lastScanStatus === "running" ? (
      // running — законный промежуточный статус последнего скана
      <span className="rh-state rh-busy" title="Идет анализ">
        Идет анализ
      </span>
    ) : entry.lastScanStatus === "bad" ? (
      // последний скан упал (пригодный старый индекс сработал бы веткой выше).
      // Призыв запустить заново — только если кнопка анализа есть (свой репозиторий и токен)
      <StatePill icon={CircleExclamation} tone="danger" title={failedAnalysisHint(canAnalyze)}>
        Ошибка анализа
      </StatePill>
    ) : entry.lastScanAt !== null ? (
      <StatePill icon={CircleDashed} title="Проанализировали – данных для оценки не хватило">
        Оценки нет
      </StatePill>
    ) : !entry.inCatalog ? (
      // речь о каталоге сервиса: на SourceCraft репозиторий может быть, но у нас
      // его еще не анализировали
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

  // пункта ручной проверки прав нет: права проверяются сами — при добавлении,
  // после смены токена и в фоне
  const menuItems = [
    ...(entry.recommendationsCount !== null && entry.recommendationsCount > 0
      ? // не href: пункт меню рендерится обычной ссылкой без linkProps и
        // перезагружал бы страницу
        [{ text: "Открыть рекомендации", action: () => navigate(recommendationsHref(href)) }]
      : []),
    { text: "Убрать из избранного", action: onRemove, disabled: busy, theme: "danger" as const },
  ];

  return (
    <li className="rh-repo-item">
      {/* слой-ссылка: клик по пустому месту строки ведет в карточку; с клавиатуры
          и для скринридера ссылка — имя репозитория, слой из обхода убран */}
      <a className="rh-repo-item__cover" {...linkProps(href)} tabIndex={-1} aria-hidden="true" />
      <span className="rh-repo-item__avatar">
        <RepoAvatar repo={repo} logoUrl={entry.logoUrl} size="l" />
      </span>
      <div className="rh-repo-item__content">
        <div className="rh-repo-item__head">
          <Link {...linkProps(href)} view="primary" className="rh-repo-item__name">
            <RepoSlug org={org} repo={repo} variant="subheader-2" />
          </Link>
          {entry.fraudFlag?.flag === true && entry.fraudFlag.factors.length > 0 && (
            <ActionTooltip title={FRAUD_TITLE} description={FRAUD_EXPLAIN}>
              <span className="rh-rating-fraud" role="img" aria-label={FRAUD_TITLE} {...TIP_TARGET}>
                <Icon data={Flag} size={14} />
              </span>
            </ActionTooltip>
          )}
          <AccessRights access={access} lastCheckedAt={lastCheckedAt} />
        </div>
        <Meta>
          <MetaItem>
            <LanguageName name={entry.language} color={entry.languageColor} />
          </MetaItem>
          {entry.lastScanAt && scored && (
            <MetaItem icon={ArrowsRotateRight} title="Последний анализ">
              {fmtDateTime(entry.lastScanAt)}
            </MetaItem>
          )}
          {/* счетчик рекомендаций — ссылкой к разделу рекомендаций на карточке.
              null (нет прав) и 0 — строки нет */}
          {entry.recommendationsCount !== null && entry.recommendationsCount > 0 && (
            <MetaItem>
              {/* иконка внутри ссылки, чтобы красилась вместе с текстом */}
              <Link {...linkProps(recommendationsHref(href))} className="rh-repo-item__link">
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
        {/* кнопка анализа — только на своем репозитории (по сохраненной проверке
            прав own); у чужого и непроверенного ее нет вовсе, а не disabled */}
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


// ========== ПОРТ 5: панель заданий ==========

// Своего опроса /api/me/jobs здесь нет: один опрос на вкладку живет в
// session.tsx, там же событие «задания изменились» (announceJobsChanged).

/** Опрос заданий не удался — список мог устареть. */
export const JOBS_STALE_TEXT = "Не удалось обновить задания – список мог устареть, повторим автоматически.";

/**
 * Кнопка «Задания» в шапке и ее панель. Кнопка видна всегда; пока идет хоть
 * один анализ, по ней бежит та же штриховка, что в строке списка, а если
 * последний анализ упал — иконка и число цветом ошибки. Панель — Popup без
 * заголовка: переключатель «Активные / История» и строки заданий.
 */
export function JobsBell() {
  const { jobs, failing } = useAnalysis();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"active" | "history" | null>(null);
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  // до первого ответа /api/me/jobs счетчика нет, чтобы не показывать ложный 0
  const active = jobs?.active ?? [];
  const recent = jobs?.recent ?? [];
  const failed = recent.filter((j) => j.phase === "failed").length;
  const busy = active.length > 0;
  // тревога — только если упало последнее завершенное задание (recent идет от
  // новых к старым): старая ошибка не должна держать кнопку красной после успешных анализов
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
              <JobsEmpty title="Сейчас ничего не анализируется">
                Запустить анализ можно в разделе{" "}
                <Link {...navProps("/me", close)} view="normal" className="rh-nowrap">
                  Избранное
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
            // список прокручивается внутри панели, чтобы длинная история не уходила
            // за край окна; лента по дням со временем — повторные анализы одного
            // репозитория различимы
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
 * Строка вкладки «Активные»: справа — та же серая плашка со штриховкой, что в
 * строке списка. Завершенные задания — на вкладке «История» (`HistoryRow`).
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
        {/* генерация описания AI и проверка оценки на накрутку — свои роды заданий:
            без подписи они выглядели бы идущим анализом и маскировали его запуск */}
        {job.kind === "summary" && (
          <Text color="secondary" variant="caption-2">
            описание AI
          </Text>
        )}
        {job.kind === "check" && (
          <Text color="secondary" variant="caption-2">
            проверка оценки
          </Text>
        )}
      </div>
      {/* очередь обслуживается по кругу (round-robin), а не по порядку — номер позиции не показываем */}
      <span className="rh-state rh-busy">
        {job.phase === "queued" ? "В очереди" : job.kind === "summary" ? "Генерация описания" : job.kind === "check" ? "Проверка оценки" : "Сканируется"}
      </span>

    </div>
  );
}

/**
 * Ссылка внутри панели: SPA-навигация (`linkProps`) и закрытие панели. Просто
 * передать `onClick={onNavigate}` нельзя — он перекроет `onClick` из `linkProps`,
 * и переход перезагрузит страницу целиком.
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

function JobsEmpty({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rh-jobs__empty">
      <Icon data={ListCheck} size={32} className="rh-jobs__empty-icon" />
      <Text variant="subheader-1">{title}</Text>
      <Text color="secondary">{children}</Text>
    </div>
  );
}

/** Итог задания в «Истории» иконкой; словами — в подсказке и `aria-label`. */
const HISTORY_OUTCOME: Record<"done" | "failed" | "refused", { icon: IconData; cls: string; text: string }> = {
  done: { icon: CircleCheck, cls: "rh-state__icon_success", text: "Готово" },
  failed: { icon: CircleExclamation, cls: "rh-state__icon_danger", text: "Ошибка" },
  // отказ — только вердикт о правах; сбой SourceCraft запуск не отклоняет
  refused: { icon: CircleExclamation, cls: "rh-state__icon", text: "Не запущен: нет прав на анализ этого репозитория" },
};

/**
 * Строка «Истории»: справа время взятия в работу и итог иконкой. У ошибки
 * причина — второй строкой: ее и нужно прочесть, чтобы понять, что делать.
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
        {job.kind === "summary" && (
          <Text color="secondary" variant="caption-2">
            описание AI
          </Text>
        )}
        {job.kind === "check" && (
          <Text color="secondary" variant="caption-2">
            проверка оценки
          </Text>
        )}
        {job.phase === "failed" && job.error && (
          <Text color="secondary" variant="caption-2" ellipsis title={job.error}>
            {job.error}
          </Text>
        )}
      </div>
      {time && (
        <Text color="secondary" className="rh-jobs__time">
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
 * Видимость репозитория по последней проверке прав зрителя, дата проверки — в
 * подсказке. Без проверки строка молчит: права проверяются сами, ручного пункта нет.
 */
function AccessRights({ access, lastCheckedAt }: { access: import("../api/me").FavoriteEntry["access"]; lastCheckedAt: string | null }) {
  if (!access) return null;
  const checked = lastCheckedAt ? ` (проверено ${fmtDateTime(lastCheckedAt)})` : "";
  return (
    <Flex gap={1} alignItems="center" className="rh-repo-item__labels">
      {/* та же плашка, что на карточке: все 3 значения SourceCraft, «неизвестно» — без плашки */}
      <VisibilityPill value={access.visibility} titleSuffix={checked} />
    </Flex>
  );
}
