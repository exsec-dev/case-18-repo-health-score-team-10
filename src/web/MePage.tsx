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
import { Alert, Button, Dialog, Flex, Icon, Label, Link, Spin, Text, TextInput, useToaster } from "@gravity-ui/uikit";
import { useCallback, useEffect, useRef, useState } from "react";
import { type MeResponse, type MyReposResponse, type RepoCard, fetchJson, logout, mutateJson, useJson } from "./api";
import { fmtDateTime, fmtScore } from "./format";
import { linkProps, repoHref } from "./router";
import { Page, UserAvatar, displayName, logoutFailedToast } from "./Shell";
import { AsideSection, EmptyState, LanguageName, Meta, MetaItem, PageHeader, RepoAvatar, SkeletonRows } from "./ui";

const SLUG_RE = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i;
const CRUMBS = [{ text: "Личный кабинет" }];

type ScanJobState = { sinceScanId: number; startedAt: number; seenScanId: number | null; phase: "queued" | "running" };

export function MePage() {
  const me = useJson<MeResponse>("/api/me");

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
      {data.hasPat ? (
        <MyReposSection />
      ) : (
        <EmptyState
          icon={Key}
          title="Добавьте токен, чтобы увидеть свои репозитории"
          description="Персональный токен SourceCraft открывает ваш namespace, CI-раны и AppSec ваших репозиториев. Добавьте его в блоке «Токен доступа»."
        />
      )}
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

// ---------- мои репозитории: список + ручной слаг + запуск анализа ----------

function MyReposSection() {
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
  }, [jobs, toaster]);

  const slugError = manualSlug !== "" && !SLUG_RE.test(manualSlug) ? "формат: org/repo" : undefined;

  return (
    <Flex direction="column" gap={3}>
      <Flex direction="column" gap={1}>
        <Text variant="subheader-2" as="h2">
          Мои репозитории
        </Text>
        <Text color="complementary">
          Список читается из вашего namespace на SourceCraft по токену. Свои репозитории можно добавить и вручную: чужие
          и недоступные платформа сама не покажет.
        </Text>
      </Flex>

      <Flex gap={2} alignItems="flex-start" wrap>
        <div style={{ flex: "1 1 240px", maxWidth: 360 }}>
          <TextInput
            size="m"
            placeholder="org/repo"
            value={manualSlug}
            onUpdate={(v) => setManualSlug(v.trim())}
            hasClear
            controlProps={{ "aria-label": "Добавить репозиторий по слагу org/repo" }}
            errorPlacement="outside"
            validationState={slugError ? "invalid" : undefined}
            errorMessage={slugError}
          />
        </div>
        <Button
          view="action"
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

      {repos.state.kind === "loading" && <SkeletonRows rows={3} height={60} />}
      {repos.state.kind === "error" && (
        <Alert theme="warning" view="outlined" title="Список не получился" message={repos.state.message} actions={[{ text: "Повторить", handler: repos.reload }]} />
      )}
      {repos.state.kind === "ok" && repos.state.data.entries.length === 0 && (
        <Text color="secondary">
          В namespace <Text variant="code-inline-1">{repos.state.data.username}</Text> публичных репозиториев нет — добавьте
          свой слагом выше.
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
  const scored = entry.score !== null;
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
        ) : scored ? (
          <Flex direction="column" alignItems="flex-end" gap={0}>
            <Flex gap={1} alignItems="baseline">
              <Text variant="subheader-3">{fmtScore(entry.score)}</Text>
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
