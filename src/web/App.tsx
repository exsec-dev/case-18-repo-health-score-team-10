// App.tsx — развилка маршрутов внутри каркаса SourceCraft (Shell.tsx).
// Мета (версия модели, имена и веса категорий, порог NULL) грузится с сервера
// один раз, чтобы экран и методика не разъезжались при смене model_version.
// Сессия и задания — одно состояние на вкладку (`AppState` в session.tsx):
// один `/api/me`, один опрос `/api/me/jobs`, тост об итоге анализа на любом экране.
import { Alert, Flex } from "@gravity-ui/uikit";
import { useState } from "react";
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

export function App() {
  return (
    <AppState>
      <Routes />
    </AppState>
  );
}

function Routes() {
  const route = useRoute();
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
    </Shell>
  );
}
