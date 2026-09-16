// MePage.tsx — «Мой кабинет» (В4/Б5): слои идентичности (Q4) — вход
// Я ID (UX), PAT SourceCraft (права на данные). Секции: PAT-окно
// github-style (вставка → живая проверка → зашифрованное хранение,
// замена/удаление), «мои репозитории» (PAT + ручной ввод слага —
// спискового юзерского эндпоинта в доках нет), запуск own-анализа с
// очередью и опросом статуса, настройки бюджетов скана (тогл-дефолт,
// значения, «снять лимит» — решение 15.09; секция расширяема под
// LLM-оп-ин В5). Токен НИКОГДА не возвращается API и не логируется.
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Button, Card, Flex, Label, Link, Loader, Switch, Text, TextInput } from "@gravity-ui/uikit";
import {
  MeResponse,
  MyReposResponse,
  RepoCard,
  ScanSettings,
  fetchJson,
  mutateJson,
  useJson,
  type AsyncState,
} from "./api";
import { fmtDateTime, fmtScore } from "./format";
import { linkProps, meRepoHref } from "./router";

const SLUG_RE = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i;

/** Форматирование бюджетов: человекочетаемые МБ/ГБ и минуты. */
export function fmtBytes(bytes: number | null): string {
  if (bytes === null) return "без лимита";
  const gb = bytes / 1024 / 1024 / 1024;
  if (gb >= 1) return `${Math.round(gb * 100) / 100} ГБ`;
  return `${Math.round(bytes / 1024 / 1024)} МБ`;
}

function fmtMinutes(ms: number | null): string {
  if (ms === null) return "без лимита";
  const min = ms / 60_000;
  return min >= 60 ? `${Math.round((min / 60) * 10) / 10} ч` : `${Math.round(min)} мин`;
}

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
      {data.hasPat && <MyReposSection />}
      <SettingsSection />
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
          Публичный рейтинг работает и без входа — ссылка «Рейтинг» в шапке. Security и CI/CD считаются только
          здесь: в общий рейтинг они не вкладываются (требование организаторов).
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
        const card = await fetchJson<RepoCard>(
          `/api/me/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}`,
        );
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
          const card = await fetchJson<RepoCard>(
            `/api/me/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}`,
          );
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
                ownScore={entry.ownScore}
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
  ownScore: number | null;
  lastScanAt: string | null;
  job: ScanJobState | null;
  onScan: () => void;
}) {
  const { org, repo, job } = props;
  return (
    <Flex gap={4} alignItems="center" wrap style={{ borderTop: "1px solid var(--g-color-line-generic)", paddingTop: "var(--g-spacing-3)" }}>
      <Flex direction="column" gap={1} style={{ minWidth: 220, flex: 1 }}>
        <Link {...linkProps(meRepoHref(org, repo))}>
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
      ) : props.ownScore !== null ? (
        <Flex gap={2} alignItems="center">
          <Text variant="subheader-2">{fmtScore(props.ownScore)}</Text>
          <Text color="secondary">/ 100 own{props.lastScanAt ? ` · ${fmtDateTime(props.lastScanAt)}` : ""}</Text>
        </Flex>
      ) : (
        <Label theme="unknown">ещё не анализировали</Label>
      )}
      <Button size="m" view={props.ownScore !== null ? "outlined" : "action"} onClick={props.onScan} disabled={job !== null}>
        {props.ownScore !== null ? "Пересканировать" : "Анализировать"}
      </Button>
    </Flex>
  );
}

// ---------- настройки бюджетов (третий слой конфига, решение 15.09) ----------

interface SettingsResponse {
  scan: ScanSettings;
  defaults: { maxBytes: number; timeoutMs: number; degrade: { enabled: boolean; maxBytes: number; timeoutMs: number } };
}

function SettingsSection() {
  const settings = useJson<SettingsResponse>("/api/me/settings");
  if (settings.state.kind === "loading") return null;
  if (settings.state.kind === "error") return null; // без сессии секции нет

  return <SettingsForm key={JSON.stringify(settings.state.data.scan)} initial={settings.state.data} reload={settings.reload} />;
}

function SettingsForm({ initial, reload }: { initial: SettingsResponse; reload: () => void }) {
  const [useDefaults, setUseDefaults] = useState(initial.scan.useDefaults);
  // пустое поле = снять лимит (null); числа вводятся в МБ/мин
  const [mb, setMb] = useState(initial.scan.maxBytes === null ? "" : String(Math.round(initial.scan.maxBytes / 1024 / 1024)));
  const [minutes, setMinutes] = useState(initial.scan.timeoutMs === null ? "" : String(Math.round(initial.scan.timeoutMs / 60_000)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function save() {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const maxBytes = mb === "" ? null : Math.round(Number(mb) * 1024 * 1024);
      const timeoutMs = minutes === "" ? null : Math.round(Number(minutes) * 60_000);
      if (maxBytes !== null && (!Number.isFinite(maxBytes) || maxBytes <= 0)) throw new Error("размер: ожидается число МБ > 0");
      if (timeoutMs !== null && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) throw new Error("таймаут: ожидается число минут > 0");
      await mutateJson("/api/me/settings", "PUT", { scan: { useDefaults, maxBytes, timeoutMs } });
      setSaved(true);
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card view="outlined" style={{ padding: "var(--g-spacing-5)" }}>
      <Flex direction="column" gap={4}>
        <Flex direction="column" gap={1}>
          <Text variant="subheader-2">Бюджеты скана</Text>
          <Text color="secondary">
            Первая попытка клонирования: серверный дефолт {fmtBytes(initial.defaults.maxBytes)} /{" "}
            {fmtMinutes(initial.defaults.timeoutMs)}; деградационный ярус {fmtBytes(initial.defaults.degrade.maxBytes)} /{" "}
            {fmtMinutes(initial.defaults.degrade.timeoutMs)}{" "}
            {initial.defaults.degrade.enabled ? "(включён)" : "(выключен)"}. Владелец большого репозитория может
            поднять свои лимиты или снять их — цена известна заранее.
          </Text>
        </Flex>
        <Flex gap={6} alignItems="center" wrap>
          <Switch
            checked={useDefaults}
            onUpdate={(v) => {
              setUseDefaults(v);
              setSaved(false);
            }}
            content="Использовать серверные дефолты"
            size="m"
          />
          {!useDefaults && (
            <Flex gap={3} wrap alignItems="flex-end">
              <TextInput
                label="Диск-бюджет, МБ"
                placeholder="без лимита"
                value={mb}
                onUpdate={(v) => {
                  setMb(v.trim());
                  setSaved(false);
                }}
                hasClear
                size="m"
                style={{ width: 180 }}
              />
              <TextInput
                label="Таймаут, мин"
                placeholder="без лимита"
                value={minutes}
                onUpdate={(v) => {
                  setMinutes(v.trim());
                  setSaved(false);
                }}
                hasClear
                size="m"
                style={{ width: 160 }}
              />
              <Text color="secondary">пустое поле = «снять лимит»</Text>
            </Flex>
          )}
        </Flex>
        <Flex gap={3} alignItems="center">
          <Button view="action" size="m" onClick={save} loading={busy} disabled={busy}>
            Сохранить
          </Button>
          {saved && <Label theme="success">сохранено — действует на новые сканы</Label>}
        </Flex>
        {error && <Alert theme="danger" title="Настройки не сохранены" message={error} />}
      </Flex>
    </Card>
  );
}

/** Заголовок шапки: логин/вход (App.tsx использует для чипа). */
export function useMe(): AsyncState<MeResponse> {
  const { state } = useJson<MeResponse>("/api/me");
  return state;
}
