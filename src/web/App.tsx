// App.tsx — оболочка приложения и развилка маршрутов (History API,
// src/web/router.ts). Мета грузится один раз на всё приложение: версия
// модели, имена и веса категорий, порог NULL приходят с сервера, чтобы
// экран и методика не разъезжались при смене model_version.
import { Alert, Flex, Link, Text } from "@gravity-ui/uikit";
import type { MetaResponse } from "./api";
import { useJson } from "./api";
import { Rating } from "./Rating";
import { RepoPage } from "./RepoPage";
import { linkProps, useRoute } from "./router";

export function App() {
  const route = useRoute();
  const meta = useJson<MetaResponse>("/api/meta");
  const metaData = meta.state.kind === "ok" ? meta.state.data : null;

  return (
    <Flex direction="column" gap={5} style={{ padding: "var(--g-spacing-8)", maxWidth: 1280, margin: "0 auto" }}>
      <Flex gap={4} alignItems="baseline">
        <Link {...linkProps("/")}>
          <Text variant="subheader-3">SourceCraft Repo Health</Text>
        </Link>
        {route.kind === "repo" && <Text color="secondary">{route.org}/{route.repo}</Text>}
      </Flex>

      {route.kind === "rating" && <Rating search={route.search} meta={metaData} />}
      {route.kind === "repo" && <RepoPage org={route.org} repo={route.repo} meta={metaData} />}
      {route.kind === "not-found" && (
        <Alert
          theme="warning"
          title="Страница не найдена"
          message={`Адрес ${route.path} не соответствует ни одному экрану. Рейтинг живёт на «/», карточка — на «/repo/{org}/{repo}».`}
        />
      )}
    </Flex>
  );
}
