// main.tsx — вход фронтенда: стили Gravity UI один раз, язык компонентов,
// тема. Бандлит Bun (HTML-импорт в server.ts), отдельной сборки нет.
import "@gravity-ui/uikit/styles/fonts.css";
import "@gravity-ui/uikit/styles/styles.css";

import { configure, Lang, ThemeProvider } from "@gravity-ui/uikit";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";

configure({ lang: Lang.Ru });

const root = document.getElementById("root");
if (!root) throw new Error("index.html: нет #root");

createRoot(root).render(
  <StrictMode>
    <ThemeProvider theme="system">
      <App />
    </ThemeProvider>
  </StrictMode>,
);
