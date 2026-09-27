// main.tsx — вход фронтенда: стили Gravity UI один раз, язык компонентов,
// тема и тостер. Бандлит Bun (HTML-импорт в server.ts), отдельной сборки нет.
// Стили @gravity-ui/navigation подтягивает сам пакет (CSS-импорты в его JS).
import "@gravity-ui/uikit/styles/fonts.css";
import "@gravity-ui/uikit/styles/styles.css";

import { configure, Lang, ThemeProvider, Toaster, ToasterComponent, ToasterProvider } from "@gravity-ui/uikit";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { HEALTHCRAFT_MARK_SVG, PRODUCT_NAME } from "./logo";
import { useAppTheme } from "./prefs";

// 27.09 (стенд после выкладки В5.5: синяя иконка ссылки в рейтинге, заглушки уже 430 px):
// наши стили — ПОСЛЕ импорта App. Компоненты uikit и navigation подключают свой CSS
// внутри своих модулей, и production-бандл Bun кладет CSS в порядке импортов: при
// импорте наших файлов выше App правила компонентов оказывались НИЖЕ наших и выигрывали
// при равной специфичности (в dev порядок другой — дефект виден только на стенде).
// Правило специфичности из docs/ui/gravity-uikit.md остается; порядок — вторая страховка.
// палитра SourceCraft (см. комментарий в файле) — после стилей uikit
import "./theme.css";
import "./layout.css";

configure({ lang: Lang.Ru });

// название и значок вкладки — из одного места с логотипом rail
document.title = PRODUCT_NAME;
const favicon = document.createElement("link");
favicon.rel = "icon";
favicon.type = "image/svg+xml";
favicon.href = `data:image/svg+xml,${encodeURIComponent(HEALTHCRAFT_MARK_SVG)}`;
document.head.appendChild(favicon);

const toaster = new Toaster();

function Root() {
  const [theme] = useAppTheme();
  return (
    <ThemeProvider theme={theme}>
      <ToasterProvider toaster={toaster}>
        <App />
        <ToasterComponent />
      </ToasterProvider>
    </ThemeProvider>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("index.html: нет #root");

createRoot(root).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
