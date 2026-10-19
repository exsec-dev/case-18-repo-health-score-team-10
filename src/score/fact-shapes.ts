import type { AppsecScaValue } from "../collectors/appsec";
// Формы значений фактов, которые читает score-слой (compute/recommend).
// Поля — unknown: вход это JSON из facts.value, и типы проверяет потребитель
// (num/bool на месте); формы описывают структуру, но не гарантируют типы.

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

/** appsec.findings — форма значения коллектора AppSec. */
export interface AppsecFindingsValue {
  severity_counts?: Record<string, unknown>;
  resolved_share?: unknown;
  secrets_critical?: unknown;
  /** уязвимые пакеты SCA (collectors/appsec.ts AppsecScaValue); null — корзины не ответили; нет — старый факт */
  sca?: AppsecScaValue | null;
  sca_note?: string;
}
