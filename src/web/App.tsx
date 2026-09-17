// App.tsx — развилка маршрутов (History API, src/web/router.ts) внутри
// каркаса SourceCraft (Shell.tsx). Мета грузится один раз на всё
// приложение: версия модели, имена и веса категорий, порог NULL приходят
// с сервера, чтобы экран и методика не разъезжались при смене
// model_version. Сессия (В4) нужна каркасу: вход в rail или логин.
import { CircleQuestion } from "@gravity-ui/icons";
import type { MeResponse, MetaResponse } from "./api";
import { useJson } from "./api";
import { MePage } from "./MePage";
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

  // карточка репозитория — часть раздела «Рейтинг»: туда ведут его строки
  const section: Section = route.kind === "rating" || route.kind === "repo" ? "rating" : route.kind === "me" ? "me" : null;

  return (
    <Shell section={section} me={meData}>
      {route.kind === "rating" && <Rating search={route.search} meta={metaData} />}
      {route.kind === "repo" && <RepoPage org={route.org} repo={route.repo} meta={metaData} />}
      {route.kind === "me" && <MePage />}
      {route.kind === "not-found" && (
        <Page crumbs={[{ text: "Страница не найдена" }]}>
          <EmptyState
            icon={CircleQuestion}
            title="Страница не найдена"
            description={`Адрес ${route.path} не соответствует ни одному экрану. Рейтинг живёт на «/», карточка репозитория — на «/repo/{org}/{repo}», кабинет — на «/me».`}
            actions={[{ text: "К рейтингу", view: "action", onClick: () => navigate("/") }]}
          />
        </Page>
      )}
    </Shell>
  );
}
