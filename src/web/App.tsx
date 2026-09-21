// App.tsx — развилка маршрутов (History API, src/web/router.ts) внутри
// каркаса SourceCraft (Shell.tsx). Мета грузится один раз на всё
// приложение: версия модели, имена и веса категорий, порог NULL приходят
// с сервера, чтобы экран и методика не разъезжались при смене
// model_version. Сессия (В4) нужна каркасу: вход в rail или логин.
// В4.8.5: сессия и задания — одно состояние на вкладку (`AppState`,
// session.tsx): один `/api/me`, один опрос `/api/me/jobs`, тост об итоге
// анализа из любого экрана.
import { CircleQuestion } from "@gravity-ui/icons";
import { Alert, Flex } from "@gravity-ui/uikit";
import type { MetaResponse } from "./api";
import { dataOf, useJson } from "./api";
import { JobsBell, MePage, SettingsPage } from "./MePage";
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
      {route.kind === "rating" && <Rating search={route.search} meta={metaData} metaFailed={metaFailed !== null} />}
      {/* В4.8.5 (К8.5.1, С9-2): `key` по слагу — состояние карточки A (фаза
          анализа, опросы) не переезжает на карточку B при SPA-переходе */}
      {route.kind === "repo" && <RepoPage key={`${route.org}/${route.repo}`} org={route.org} repo={route.repo} meta={metaData} />}
      {route.kind === "me" && <MePage meta={metaData} />}
      {route.kind === "settings" && <SettingsPage />}
      {route.kind === "not-found" && (
        <Page crumbs={[{ text: "Страница не найдена" }]}>
          {/* Доводка 21.09: перечисление маршрутов убрано. «/repo/{org}/{repo}»
              ничего не говорит человеку, перешедшему по старой ссылке, — это
              отладочный вывод, показанный посетителю. У платформы на 404 ровно
              две строки и действие; сам адрес зритель видит в адресной
              строке браузера. */}
          <EmptyState
            icon={CircleQuestion}
            title="Страница не найдена"
            description="Такого адреса нет или он изменился."
            actions={[{ text: "К рейтингу", view: "action", size: "l", onClick: () => navigate("/") }]}
          />
        </Page>
      )}
    </Shell>
  );
}
