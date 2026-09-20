// App.tsx — развилка маршрутов (History API, src/web/router.ts) внутри
// каркаса SourceCraft (Shell.tsx). Мета грузится один раз на всё
// приложение: версия модели, имена и веса категорий, порог NULL приходят
// с сервера, чтобы экран и методика не разъезжались при смене
// model_version. Сессия (В4) нужна каркасу: вход в rail или логин.
import { CircleQuestion } from "@gravity-ui/icons";
import { Alert, Flex } from "@gravity-ui/uikit";
import type { MeResponse, MetaResponse } from "./api";
import { useJson } from "./api";
import { JobsBell, MePage, SettingsPage } from "./MePage";
import { Rating } from "./Rating";
import { RepoPage } from "./RepoPage";
import { navigate, useRoute } from "./router";
import { Page, Shell, type Section } from "./Shell";
import { EmptyState } from "./ui";

export function App() {
  const route = useRoute();
  const meta = useJson<MetaResponse>("/api/meta");
  const me = useJson<MeResponse>("/api/me");
  const metaData = meta.state.kind === "ok" ? meta.state.data : null;
  const meData = me.state.kind === "ok" ? me.state.data : null;
  // В4.4 (кластер M-9): сбой /api/meta больше не молчит скелетоном —
  // честный Alert с повтором; страницы живут на RU-именах из констант
  const metaFailed = meta.state.kind === "error" ? meta.state.message : null;

  // карточка репозитория — часть раздела «Рейтинг»: туда ведут его строки
  const section: Section =
    route.kind === "rating" || route.kind === "repo" ? "rating" : route.kind === "me" ? "me" : route.kind === "settings" ? "settings" : null;

  return (
    <Shell section={section} me={meData} globalActions={meData?.login ? <JobsBell /> : null}>
      {metaFailed && (
        <Flex style={{ padding: "var(--g-spacing-4)" }}>
          <Alert
            theme="warning"
            view="outlined"
            title="Не удалось загрузить справочник сервиса"
            message={`${metaFailed}. Имена категорий и пороги показаны запасными значениями.`}
            actions={[{ text: "Повторить", handler: meta.reload }]}
          />
        </Flex>
      )}
      {route.kind === "rating" && <Rating search={route.search} meta={metaData} />}
      {route.kind === "repo" && <RepoPage org={route.org} repo={route.repo} meta={metaData} />}
      {route.kind === "me" && <MePage meta={metaData} />}
      {route.kind === "settings" && <SettingsPage />}
      {route.kind === "not-found" && (
        <Page crumbs={[{ text: "Страница не найдена" }]}>
          <EmptyState
            icon={CircleQuestion}
            title="Страница не найдена"
            description={`Адрес ${route.path} не соответствует ни одному экрану. Рейтинг живет на «/», карточка репозитория – на «/repo/{org}/{repo}», «Мои репозитории» – на «/me», настройки – на «/settings».`}
            actions={[{ text: "К рейтингу", view: "action", onClick: () => navigate("/") }]}
          />
        </Page>
      )}
    </Shell>
  );
}
