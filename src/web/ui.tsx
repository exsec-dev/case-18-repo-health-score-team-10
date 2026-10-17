// ui.tsx — мелкие общие куски экранов поверх uikit: заголовок страницы,
// заголовок блока правой панели, мета-строка, скелетон, пустое состояние.
// Новых стилей не вводят: варианты Text, токены и классы layout.css.
import {
  ActionTooltip,
  Avatar,
  Flex,
  Icon,
  Label,
  Link,
  PlaceholderContainer,
  Progress,
  Skeleton,
  Text,
  type AvatarSize,
  type IconData,
  type PlaceholderContainerActionProps,
} from "@gravity-ui/uikit";
import { useEffect, useRef, useState, type ComponentType, type ReactNode, type SVGProps } from "react";
import { ArrowRight, Globe, Lock, Persons } from "@gravity-ui/icons";
import { linkProps } from "./router";
import { visibilityPill } from "./cardView";
import { SCORE_LEGEND_TITLE, SCORE_SCALE, fmtCoverage, scoreTheme, sentence, slugOf } from "./format";

/**
 * Заголовок страницы: header-2 24/28 и пояснение body-2 15/20 через 6px, до
 * содержимого 24px — замер «Top repositories» у SourceCraft. На телефоне —
 * header-1 (класс в layout.css): длинное имя в 24px уходит в перенос.
 */
export function PageHeader({ title, description, end }: { title: ReactNode; description?: ReactNode; end?: ReactNode }) {
  return (
    <Flex gap={3} alignItems="flex-start" justifyContent="space-between" wrap style={{ marginBottom: "var(--g-spacing-6)" }}>
      <Flex direction="column" className="rh-page-head" style={{ minWidth: 0 }}>
        <Text variant="header-2" as="h1" className="rh-page-title">
          {title}
        </Text>
        {description && (
          <Text variant="body-2" color="complementary">
            {description}
          </Text>
        )}
      </Flex>
      {end}
    </Flex>
  );
}

/**
 * Блок правой панели: заголовок subheader-3 17/24 (как «About» у SourceCraft) и содержимое. `help` — иконка-подсказка
 * РЯДОМ с заголовком: пояснение к блоку не читается ещё одним абзацем панели и не
 * занимает высоту.
 */
export function AsideSection({ title, help, children }: { title: ReactNode; help?: ReactNode; children: ReactNode }) {
  return (
    /* шаг 8 (32px), как между блоками правой колонки SourceCraft: блоки идут
       подряд без разделителей, и на меньшем шаге читались бы одним полотном */
    <Flex as="section" className="rh-aside-section" direction="column" gap={2} style={{ marginBottom: "var(--g-spacing-8)" }}>
      <Flex gap={1} alignItems="center">
        <Text variant="subheader-3" as="h2">
          {title}
        </Text>
        {help}
      </Flex>
      {children}
    </Flex>
  );
}

/**
 * Легенда шкалы — ОДИН блок на рейтинг и карточку, первым в панели. На рейтинге
 * он даёт якорь «как выглядит плохое»: верх выдачи плотный, и без легенды 72
 * читается как провал. Слова и диапазоны — из `SCORE_SCALE`, чтобы шкала на
 * экранах и в MD-отчёте не разъехалась. «Нет данных» в легенду НЕ входит: это не
 * полоса шкалы, а отсутствие числа (tri-state) — про него отдельная строка.
 */
export function ScoreLegend({ coverageNullBelow, withNote = true }: { coverageNullBelow?: number; withNote?: boolean }) {
  return (
    <AsideSection title={SCORE_LEGEND_TITLE}>
      <Flex direction="column" gap={2}>
        {SCORE_SCALE.map((step) => (
          <Flex key={step.theme} gap={2} alignItems="center" justifyContent="space-between">
            <Label theme={step.theme} size="s">
              {sentence(step.word)}
            </Label>
            <Text variant="body-2" style={{ fontVariantNumeric: "tabular-nums" }}>
              {step.range}
            </Text>
          </Flex>
        ))}
      </Flex>
      {/* карточка отключает абзац пропом: у нее эта фраза стоит в «Что учитывается» */}
      {withNote && (
      <Text variant="body-1" color="complementary">
        {coverageNullBelow === undefined
          ? "При недостаточной полноте данных оценка не рассчитывается. Отсутствующие данные не учитываются как нулевые значения."
          : `При полноте данных ниже ${fmtCoverage(coverageNullBelow)} оценка не рассчитывается. Отсутствующие данные не учитываются как нулевые значения.`}
      </Text>
      )}
    </AsideSection>
  );
}

/**
 * Полоса оценки 0–100 — одна на все экраны: таблица рейтинга, строки категорий
 * карточки, «Избранное». Progress Gravity, уровень — цветом заливки по шкале
 * (`scoreTheme`); высота 8px задана в layout.css. Пять разных полос и кольцо
 * показывали одно и то же число пятью способами.
 */
export function ScoreBar({ value, width, label, neutral = false }: { value: number; width: number | string; label?: string; neutral?: boolean }) {
  // neutral — серая заливка (категории в «Сравнении»): уровень там несет индекс,
  // а цветные полосы в каждой строке спорили с ним
  return (
    <span className={neutral ? "rh-score-bar rh-score-bar_neutral" : "rh-score-bar"} style={{ width }} role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      <Progress value={Math.max(0, Math.min(100, Math.round(value)))} size="s" theme={scoreTheme(value)} />
    </span>
  );
}

/**
 * Аватар репозитория: logo.url платформы, а без него или при ошибке загрузки
 * (нет сети, битая ссылка) — инициалы: внешняя картинка не обязательна для UI.
 * Инициалы нейтральные, как заглушка аватара у SourceCraft: цветные квадраты
 * давали каждой второй строке рейтинга лишний цветной акцент.
 */
export function RepoAvatar({ repo, logoUrl, size }: { repo: string; logoUrl: string | null; size: AvatarSize }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
    if (!logoUrl) return;
    const probe = new Image();
    probe.onerror = () => setFailed(true);
    probe.src = logoUrl;
    return () => {
      probe.onerror = null;
    };
  }, [logoUrl]);
  // аватар декоративен — имя стоит рядом текстом. Avatar uikit 7.49 теряет alt=""
  // (`props.alt || title`), и <img> остается без alt; обертка aria-hidden убирает его
  // из дерева доступности, `display: contents` не меняет раскладку
  return (
    <span aria-hidden="true" style={{ display: "contents" }}>
      {logoUrl && !failed ? (
        <Avatar size={size} shape="square" imgUrl={logoUrl} alt="" loading="lazy" style={{ flexShrink: 0 }} />
      ) : (
        <Avatar
          size={size}
          shape="square"
          text={repo}
          backgroundColor="var(--g-color-base-generic)"
          color="var(--g-color-text-secondary)"
          style={{ flexShrink: 0 }}
        />
      )}
    </span>
  );
}

/**
 * Цель подсказки-метки (флаг накрутки, искра AI, стрелка места, «Устарел»)
 * фокусируется с клавиатуры и касанием —
 * ActionTooltip открывается и на фокусе. Клик не уходит в строку таблицы: касание
 * метки показывает подсказку, а не открывает карточку.
 */
export const TIP_TARGET = {
  tabIndex: 0,
  onClick: (e: { stopPropagation: () => void }) => e.stopPropagation(),
} as const;

/**
 * Язык с цветной точкой, как в списках SourceCraft; цвет — language.color платформы.
 * У известного языка без цвета платформы (например, Rich Text Format) точка
 * нейтральная, а не пропадает — цвет не выдумывается.
 * «Язык не определен» (`name === null` или `noLanguage`) точки не получает:
 * это отсутствие языка, а не язык.
 */
export function LanguageName({ name, color, noLanguage = false }: { name: string | null; color: string | null; noLanguage?: boolean }) {
  const known = name !== null && !noLanguage;
  return (
    <span className="rh-lang">
      {known && (
        <span className={color ? "rh-lang__dot" : "rh-lang__dot rh-lang__dot_neutral"} style={color ? { background: color } : undefined} aria-hidden="true" />
      )}
      {name ?? "язык не определен"}
    </span>
  );
}

/**
 * Слаг репозитория — один компонент на все экраны: форма и обрезка по ширине
 * решаются здесь. `org/repo` БЕЗ пробелов вокруг слеша — так слаг копируется
 * и вставляется; `title` несёт полную форму, чтобы обрезанное имя можно было
 * прочесть наведением.
 *
 * Не влезает — многоточие в конце всей строки, как у SourceCraft: сокращение в
 * середине и обрезка организации отдельно от имени читались хуже.
 */
export function RepoSlug({ org, repo, variant }: { org: string; repo: string; variant: "body-1" | "subheader-1" | "subheader-2" | "header-1" | "header-2" }) {
  return (
    <Text variant={variant} as={variant === "header-1" || variant === "header-2" ? "h1" : "span"} title={slugOf(org, repo)} className={variant === "header-2" ? "rh-slug rh-page-title" : "rh-slug"}>
      {slugOf(org, repo)}
    </Text>
  );
}

/**
 * Плашка видимости SourceCraft у имени репозитория: одна
 * на карточку и избранное — значение приходит от экрана (у карточки поле
 * ответа, у избранного — проверка прав). «Неизвестно» плашки не получает.
 */
export function VisibilityPill({ value, titleSuffix = "" }: { value: string | null | undefined; titleSuffix?: string }) {
  const pill = visibilityPill(value);
  if (!pill) return null;
  const icon = pill.kind === "public" ? Globe : pill.kind === "internal" ? Persons : Lock;
  // как «Public» у имени репозитория в SourceCraft: Label clear s, 24/5
  return (
    <Label theme="clear" size="s" icon={<Icon data={icon} size={14} />} title={`${pill.title}${titleSuffix}`} className="rh-visibility">
      {pill.text}
    </Label>
  );
}

/**
 * Ссылка в раздел методики документации — из каждого места, которое объясняет
 * расчет коротко («Как считается?», подсказки, «Что учитывается»). Как «How do
 * we count it?» у SourceCraft: короткое объяснение на месте, полное — в доке.
 */
/**
 * Версия методики плашкой: номер без суффикса сборки («4.5.0»), полный номер
 * («4.5.0-hci») — в подсказке. Одна на карточке и в панели рейтинга.
 */
export function ModelVersion({ version }: { version: string }) {
  const [base] = version.split("-");
  const plate = (
    <Label theme="normal" size="xs">
      {base}
    </Label>
  );
  if (base === version) return plate;
  return (
    <ActionTooltip title={`Полная версия – ${version}`}>
      <span tabIndex={0} className="rh-chip-fit">
        <span aria-hidden="true">{plate}</span>
        <span className="rh-sr-only">{`Версия методики ${version}`}</span>
      </span>
    </ActionTooltip>
  );
}

export function MethodLink({ page, children = "Подробнее о методике" }: { page: "scores" | "no-data" | "recommendations" | "metrics"; children?: ReactNode }) {
  return (
    <Link {...linkProps(`/docs/method/${page}`)} className="rh-method-link">
      {children}
      <Icon data={ArrowRight} size={14} />
    </Link>
  );
}

export function Meta({ children }: { children: ReactNode }) {
  return <div className="rh-meta">{children}</div>;
}

export function MetaItem({ icon, children, title }: { icon?: IconData; children: ReactNode; title?: string }) {
  return (
    <span className="rh-meta__item" title={title}>
      {/* серый `secondary`, а не цветной: мета-строка — реквизиты, и цветной
          текст читался бы как ссылки (5,55:1 в тёмной теме — порог прозы взят) */}
      {icon && <Icon data={icon} size={14} />}
      <Text variant="body-short" color="secondary">
        {children}
      </Text>
    </span>
  );
}

/**
 * Загрузка в форме будущего содержимого: строки нужной высоты. Вызывающие
 * стороны берут высоту того, что скелетон заменяет (строка рейтинга 56px,
 * строка категории 45px): иначе раскладка прыгает в момент загрузки.
 */
export function SkeletonRows({ rows, height = 44 }: { rows: number; height?: number }) {
  return (
    <Flex direction="column" gap={2} aria-busy="true" aria-label="Загрузка">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} style={{ height, width: "100%" }} />
      ))}
    </Flex>
  );
}

/**
 * Пустое/служебное состояние в манере платформы: текст слева, иллюстрация
 * СПРАВА, действие под текстом. У SourceCraft это `PlaceholderContainer` с плоской
 * монохромной иллюстрацией 120×120 — здесь свои в том же языке (`illustrations.tsx`).
 */
export function EmptyState({
  image: Illustration,
  title,
  description,
  actions,
  headingLevel = 2,
}: {
  image: ComponentType<SVGProps<SVGSVGElement>>;
  title: string;
  description?: ReactNode;
  /** кнопки — массивом; свой блок действий (готовые наборы «Сравнения») — узлом */
  actions?: PlaceholderContainerActionProps[] | ReactNode;
  /** уровень заголовка: 1 — заглушка вместо страницы (404), 2 — внутри страницы с заголовком */
  headingLevel?: 1 | 2;
}) {
  // PlaceholderContainer рисует заголовок `div` и принимает только строку — роль
  // заголовка ставится на готовый узел: по заголовкам навигация работает и здесь
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current?.querySelector(".g-placeholder-container__title");
    if (!el) return;
    el.setAttribute("role", "heading");
    el.setAttribute("aria-level", String(headingLevel));
  });
  return (
    <div ref={ref} className="rh-empty-wrap">
    <PlaceholderContainer
      className="rh-empty"
      size="m"
      align="left"
      direction="row"
      title={title}
      description={description}
      actions={actions}
      image={<Illustration width={120} height={120} aria-hidden="true" />}
    />
    </div>
  );
}
