// fact-shapes.ts — именованные формы значений фактов, которые читает
// score-слой (compute/recommend). Поля — unknown: вход это JSON из
// facts.value, валидация значений остаётся за потребителем (num/bool
// у места использования); формы описывают структуру, не гарантируют типы.

export interface DocsPresenceValue {
  readme?: unknown;
  license?: unknown;
  contributing?: unknown;
  codeowners?: unknown;
}

export interface ReadmeSectionFlags {
  install?: unknown;
  build?: unknown;
  test?: unknown;
}

/** docs.readme, когда README есть (payload-форма; present-поля нет). */
export interface DocsReadmeContent {
  bytes?: unknown;
  flags?: ReadmeSectionFlags;
  present?: undefined;
}

/** docs.readme, когда README нет (пустая форма; bytes/flags нет). */
export interface DocsReadmeAbsent {
  present?: boolean;
  bytes?: undefined;
  flags?: undefined;
}

export type DocsReadmeValue = DocsReadmeContent | DocsReadmeAbsent;

/** appsec.findings — схема для В4-коллектора и мутационных тестов (§2). */
export interface AppsecFindingsValue {
  severity_counts?: Record<string, unknown>;
  resolved_share?: unknown;
  secrets_critical?: unknown;
}
