// Пороги проверки на накрутку — одни числа для правил (rhythm.ts), текста улик
// на карточке и в отчете (web/format.ts) и версии правил в заметке. Модуль без
// зависимостей: его берет и веб-бандл.

/** Версия хартии флаггера, с которой действуют правила кода; заметки старше — «по прежним правилам». */
export const FLAGGER_RULES_VERSION = 9;

/** Доля коммитов роботов от всех коммитов, с которой код ставит флаг сам: людей почти нет… */
export const ROBOT_SHARE_FLAG = 0.8;
/** …при истории не короче этого числа коммитов (1 dependabot из 1 — не улика). */
export const ROBOT_RULE_MIN_COMMITS = 20;

/** Всплески синхронизации: флаг кодом от этого числа всплесков… */
export const SYNC_BURSTS_FLAG = 2;
/** …или от этой доли коммитов во всплесках; один всплеск — повод для модели, не флаг. */
export const SYNC_SHARE_FLAG = 0.1;

/** Доля коммитов людей в сериях с ровными интервалами, с которой флаг обязателен… */
export const REGULAR_SHARE_FLAG = 0.5;
/** …если обычный интервал не длиннее этого (минуты): «раз в день» — ритм человека, «раз в 30 минут» — таймера. */
export const REGULAR_INTERVAL_MAX_MINUTES = 240;

/** Всплеск недели: минимум коммитов людей за 7 дней до замера… */
export const RECENT_SPIKE_MIN = 20;
/** …во сколько раз больше обычного недельного темпа… */
export const RECENT_SPIKE_RATIO = 5;
/** …при обычном темпе не ниже этого (дробная медиана 0,5 — не темп). */
export const RECENT_BASELINE_MIN = 1;

// Слабые сигналы: ниже порогов правил, но повод позвать модель. Модель зовется
// только при WEAK_SIGNALS_FOR_MODEL сигналах и больше, иначе «подозрений нет»
// пишет код: на выборке честных репо модель флаговала половину по признакам,
// которые хартия уликами не считает (baseline 0, ровность 0.2, роботы 60%, нет
// релизов), а на синтетике с одним слабым сигналом флаговала 5 из 9 ответов.
/** Сколько слабых сигналов нужно, чтобы позвать модель. */
export const WEAK_SIGNALS_FOR_MODEL = 2;
/** Ровность от этой доли (при интервале до REGULAR_INTERVAL_MAX_MINUTES) — слабый сигнал. */
export const REGULAR_SHARE_WEAK = 0.3;
/** Роботы от этой доли (при истории от ROBOT_RULE_MIN_COMMITS и без жизни в REST) — слабый сигнал. */
export const ROBOT_SHARE_WEAK = 0.5;
/** Всплеск недели от RECENT_SPIKE_MIN коммитов и от этого кратного темпа (при темпе от RECENT_BASELINE_MIN) — слабый сигнал. */
export const RECENT_SPIKE_RATIO_WEAK = 3;

/** Доля роботов — улика (печатается и флагуется) от порога. */
export const robotShareHigh = (robots: number, commits: number): boolean => commits > 0 && robots / commits >= ROBOT_SHARE_FLAG;
/** Всплески — улика от SYNC_BURSTS_FLAG всплесков или SYNC_SHARE_FLAG доли коммитов в них. */
export const syncHigh = (bursts: number, syncCommits: number, commits: number): boolean =>
  bursts >= SYNC_BURSTS_FLAG || (bursts > 0 && commits > 0 && syncCommits / commits >= SYNC_SHARE_FLAG);
/** Ровный ритм — улика от REGULAR_SHARE_FLAG при интервале не длиннее REGULAR_INTERVAL_MAX_MINUTES. */
export const regularHigh = (share: number | null, intervalMinutes: number | null): boolean =>
  share !== null && share >= REGULAR_SHARE_FLAG && intervalMinutes !== null && intervalMinutes <= REGULAR_INTERVAL_MAX_MINUTES;
/** Всплеск недели — улика от RECENT_SPIKE_MIN коммитов и RECENT_SPIKE_RATIO× темпа при темпе от RECENT_BASELINE_MIN. */
export const recentSpikeHigh = (recent: number, baseline: number): boolean =>
  baseline >= RECENT_BASELINE_MIN && recent >= RECENT_SPIKE_MIN && recent >= RECENT_SPIKE_RATIO * baseline;
