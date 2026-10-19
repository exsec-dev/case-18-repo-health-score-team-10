// Иконки подметрик карточки — для строк вне расчета: справочных и тех, у кого нет
// балла (вместо сектора у них нечего показывать). Вынесены из RepoPage.tsx 18.10.2026.
import type { IconData } from "@gravity-ui/uikit";
import { ArrowUpArrowDown, Bug, Calendar, CalendarXmark, ChartColumn, ChartLine, Circle, CircleCheck, Clock, ClockArrowRotateLeft, CodeCommits, CodeMerge, CodePullRequest, Comment, CommentSlash, Comments, Copy, FileText, Flag, FolderTree, Hashtag, Hourglass, Key, Person, PersonGear, Persons, Pipeline, Pulse, Rocket, ScalesBalanced, ShieldCheck, SquareCheck, Stopwatch, Thunderbolt } from "@gravity-ui/icons";

/**
 * Иконка каждой подметрики. Не украшение: строк в раскрытой категории до девяти, все
 * одним кеглем, и глиф слева позволяет найти строку повторно, не перечитывая название.
 * Названия подметрик живут в словаре `src/report/submetrics.ts` (общем с MD и PDF),
 * иконки — здесь, это вид. Все из `@gravity-ui/icons`, своих рисунков не заводим;
 * незнакомый ключ получает нейтральную точку.
 */
export const SUBMETRIC_ICONS: Record<string, IconData> = {
  "documentation.readme": FileText,
  "documentation.license": ScalesBalanced,
  "documentation.contributing": Persons,
  "documentation.codeowners": PersonGear,
  "cicd.config": Pipeline,
  "cicd.pass_rate": CircleCheck,
  "cicd.duration": Stopwatch,
  "cicd.stability": ChartLine,
  "security.density": Bug,
  "security.resolved": ShieldCheck,
  "security.secrets": Key,
  "activity.fresh": Clock,
  "activity.freq": Pulse,
  "activity.bus_factor": Persons,
  "activity.contributors": Persons,
  "activity.pulls_90d": CodePullRequest,
  "activity.releases_12m": Rocket,
  "activity.mirror_likeness": Copy,
  "activity.commits_90d": CodeCommits,
  "activity.commits_365d": Calendar,
  "activity.sync_bursts": Thunderbolt,
  "issues.stale": Hourglass,
  "issues.close_days": ClockArrowRotateLeft,
  "issues.resolution": SquareCheck,
  "issues.first_resp": Comment,
  "issues.tracker_unused": CommentSlash,
  "issues.backlog_trend": ArrowUpArrowDown,
  "issues.monthly_flow": ChartColumn,
  "code.density": Flag,
  "code.old_share": CalendarXmark,
  "code.tests": CircleCheck,
  "code.root": FolderTree,
  "code.todo_total": Hashtag,
  // справочные показатели ревью PR и карта владельцев
  "activity.pr_review": CodePullRequest,
  "activity.pr_first_response": Comment,
  "activity.pr_waiting": Hourglass,
  "activity.pr_review_comments": Comments,
  "activity.pr_merge_time": CodeMerge,
  "code.ownership": Person,
};

export function submetricIcon(category: string, sub: string): IconData {
  return SUBMETRIC_ICONS[`${category}.${sub}`] ?? Circle;
}
