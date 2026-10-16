// main.tsx — вход фронтенда: стили Gravity UI один раз, язык компонентов,
// тема и тостер. Бандлит Bun (HTML-импорт в server.ts), отдельной сборки нет.
// Стили @gravity-ui/navigation подтягивает сам пакет (CSS-импорты в его JS).
import "./fonts.css";
import "@gravity-ui/uikit/styles/styles.css";

import { configure, Lang, ThemeProvider, Toaster, ToasterComponent, ToasterProvider } from "@gravity-ui/uikit";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { HEALTHCRAFT_MARK_SVG, PRODUCT_NAME } from "./logo";
import { useAppTheme } from "./prefs";

// наши стили — ПОСЛЕ импорта App. Компоненты uikit и navigation подключают свой CSS
// внутри своих модулей, а production-бандл Bun кладет CSS в порядке импортов: наши
// файлы выше App оказались бы раньше правил компонентов и проигрывали бы им при равной
// специфичности. Порядок — вторая страховка, первая — специфичность наших селекторов.
import "./theme.css";
import "./layout.css";
// в dev Bun ставит наши файлы ПЕРВЫМИ — рантайм-страховка добавляет их копии в конец
// <head>; в production она ничего не делает
import { ourStylesLast } from "./cssOrder";

ourStylesLast();

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
