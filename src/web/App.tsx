// App.tsx — развилка маршрутов внутри каркаса SourceCraft (Shell.tsx).
// Мета (версия модели, имена и веса категорий, порог NULL) грузится с сервера
// один раз, чтобы экран и методика не разъезжались при смене model_version.
// Сессия и задания — одно состояние на вкладку (`AppState` в session.tsx):
// один `/api/me`, один опрос `/api/me/jobs`, тост об итоге анализа на любом экране.
import { Alert, Flex } from "@gravity-ui/uikit";
import { Component, useEffect, useState, type ReactNode } from "react";
import { NotFoundIllustration } from "./illustrations";
import type { MetaResponse } from "./api";
import { dataOf, useJson } from "./api";
import { ComparePage } from "./ComparePage";
import { DocsPage } from "./DocsPage";
import { JobsBell, MePage, MyReposPage, SettingsPage } from "./MePage";
import { Rating } from "./Rating";
import { RepoPage } from "./RepoPage";
import { navigate, useRoute } from "./router";
import { AppState, useSession } from "./session";
import { Page, Shell, type Section } from "./Shell";
import { EmptyState } from "./ui";
import { DEMO } from "./base";
import type { Route } from "./router";

const NOT_FOUND: Route = { kind: "not-found" };

/**
 * Сбой отрисовки экрана (неожиданный ответ сервера, поломанные данные) не гасит
 * все приложение: меню и шапка остаются, на месте экрана — заглушка с повтором.
 * Смена адреса (`resetKey`) сбрасывает сбой — переход в другой раздел работает сразу.
 */
class ScreenBoundary extends Component<{ resetKey: string; children: ReactNode }, { failed: boolean; key: string }> {
  state = { failed: false, key: this.props.resetKey };

  static getDerivedStateFromError(): Partial<{ failed: boolean }> {
    return { failed: true };
  }

  static getDerivedStateFromProps(props: { resetKey: string }, state: { failed: boolean; key: string }) {
    return props.resetKey !== state.key ? { failed: false, key: props.resetKey } : null;
  }

  componentDidCatch(error: unknown): void {
    console.error("Сбой отрисовки экрана", error);
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <Page crumbs={[{ text: "Не удалось показать страницу" }]}>
        <EmptyState
          image={NotFoundIllustration}
          title="Не удалось показать страницу"
          headingLevel={1}
          description="Попробуйте еще раз – если не поможет, обновите страницу."
          actions={[
            { text: "Повторить", view: "action", size: "l", onClick: () => this.setState({ failed: false }) },
            { text: "К рейтингу", view: "outlined", size: "l", onClick: () => navigate("/") },
          ]}
        />
      </Page>
    );
  }
}

export function App() {
  return (
    <AppState>
      <Routes />
    </AppState>
  );
}

function Routes() {
  const fullRoute = useRoute();
  // демо: личных разделов нет – их адреса ведут на «не найдена»
  const route = DEMO && (fullRoute.kind === "me" || fullRoute.kind === "repos" || fullRoute.kind === "settings") ? NOT_FOUND : fullRoute;
  // слаги SourceCraft строчные: адрес с заглавными («/repo/Org/Repo») давал «не найден» —
  // ведем на тот же адрес строчными, без новой записи истории
  const repoOrg = route.kind === "repo" ? route.org : null;
  const repoName = route.kind === "repo" ? route.repo : null;
  useEffect(() => {
    if (repoOrg === null || repoName === null) return;
    if (repoOrg === repoOrg.toLowerCase() && repoName === repoName.toLowerCase()) return;
    const { search, hash } = window.location;
    navigate(`/repo/${encodeURIComponent(repoOrg.toLowerCase())}/${encodeURIComponent(repoName.toLowerCase())}${search}${hash}`, { replace: true });
  }, [repoOrg, repoName]);
  const meta = useJson<MetaResponse>("/api/meta");
  const { me } = useSession();
  const metaData = meta.state.kind === "ok" ? meta.state.data : null;
  const meData = dataOf(me);
  // сбой /api/meta не прячется за скелетоном: Alert с повтором, а страницы
  // работают на русских именах из констант
  const metaFailed = meta.state.kind === "error" ? meta.state.message : null;

  // карточка репозитория относится к «Рейтингу», но закрытый репозиторий в
  // рейтинг не входит — его карточка принадлежит «Избранному». Раздел сообщает
  // сама карточка: только она знает видимость. Смена адреса сбрасывает сообщение
  const [repoSection, setRepoSection] = useState<{ key: string; section: Section } | null>(null);
  const repoKey = route.kind === "repo" ? `${route.org}/${route.repo}` : null;
  const section: Section =
    route.kind === "repo"
      ? repoSection !== null && repoSection.key === repoKey
        ? repoSection.section
        : "rating"
      : route.kind === "rating"
        ? "rating"
        : route.kind === "me"
          ? "me"
          : route.kind === "repos"
            ? "repos"
          : route.kind === "compare"
            ? "compare"
          : route.kind === "settings"
            ? "settings"
            : route.kind === "docs"
              ? "docs"
              : null;

  return (
    <Shell section={section} me={meData} meLoading={meData === null && me.kind === "loading"} globalActions={meData?.login ? <JobsBell /> : null}>
      {metaFailed && (
        <Flex style={{ padding: "var(--g-spacing-4)" }}>
          <Alert
            theme="warning"
            view="outlined"
            title="Не удалось загрузить настройки оценки"
            message={`${metaFailed}. Названия категорий и пороги показаны по умолчанию.`}
            actions={[{ text: "Повторить", handler: meta.reload }]}
          />
        </Flex>
      )}
      <ScreenBoundary resetKey={`${window.location.pathname}${window.location.search}`}>
      {route.kind === "rating" && <Rating search={route.search} meta={metaData} metaFailed={metaFailed !== null} />}
      {/* `key` по слагу: состояние одной карточки (фаза анализа, опросы) не
          переезжает на другую при SPA-переходе */}
      {route.kind === "repo" && <RepoPage key={`${route.org}/${route.repo}`} org={route.org} repo={route.repo} meta={metaData} onSection={(s) => setRepoSection({ key: `${route.org}/${route.repo}`, section: s })} />}
      {route.kind === "me" && <MePage meta={metaData} />}
      {route.kind === "repos" && <MyReposPage />}
      {route.kind === "compare" && <ComparePage search={route.search} />}
      {route.kind === "settings" && <SettingsPage />}
      {route.kind === "docs" && <DocsPage slug={route.slug} />}
      {route.kind === "not-found" && (
        <Page crumbs={[{ text: "Страница не найдена" }]}>
          {/* как у платформы: две строки и действие, без перечня маршрутов –
              шаблоны адресов ничего не скажут пришедшему по старой ссылке */}
          <EmptyState
            image={NotFoundIllustration}
            title="Страница не найдена"
            headingLevel={1}
            description="Такого адреса нет или он изменился."
            actions={[{ text: "К рейтингу", view: "action", size: "l", onClick: () => navigate("/") }]}
          />
        </Page>
      )}
      </ScreenBoundary>
    </Shell>
  );
}
