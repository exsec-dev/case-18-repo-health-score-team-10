// ui.tsx — мелкие общие куски экранов поверх uikit: заголовок страницы,
// заголовок блока правой панели, мета-строка, скелетон, пустое состояние.
// Новых стилей не вводят: варианты Text, токены и классы layout.css.
import {
  Avatar,
  Flex,
  Icon,
  Label,
  PlaceholderContainer,
  Skeleton,
  Text,
  type AvatarSize,
  type IconData,
  type PlaceholderContainerActionProps,
} from "@gravity-ui/uikit";
import { useEffect, useState, type ReactNode } from "react";
import { SCORE_LEGEND_TITLE, SCORE_SCALE, avatarTone, fmtCoverage, sentence, slugOf } from "./format";

/** Заголовок страницы: header-1 20/24 и одна строка пояснения, как у SourceCraft. */
export function PageHeader({ title, description, end }: { title: ReactNode; description?: ReactNode; end?: ReactNode }) {
  return (
    <Flex gap={3} alignItems="flex-start" justifyContent="space-between" wrap style={{ marginBottom: "var(--g-spacing-4)" }}>
      <Flex direction="column" gap={1} style={{ minWidth: 0 }}>
        <Text variant="header-1" as="h1">
          {title}
        </Text>
        {description && <Text color="complementary">{description}</Text>}
      </Flex>
      {end}
    </Flex>
  );
}

/**
 * Блок правой панели: заголовок subheader-2 и содержимое.
 *
 * В4.6 круг 2 (Р8): у заголовка появился необязательный слот `help` —
 * иконка-подсказка РЯДОМ с заголовком. Замечание владельца 8: пояснение под
 * списком «Вклад категорий» читалось как ещё один абзац панели, хотя
 * объясняло сам список; в подсказке оно на месте и не занимает высоту.
 */
export function AsideSection({ title, help, children }: { title: ReactNode; help?: ReactNode; children: ReactNode }) {
  return (
    /* Доводка 21.09: шаг между блоками панели поднят с 6 (20px) до 7 (24px).
       Блоки идут подряд и без разделителей, и на прежнем шаге легенда шкалы,
       вклад категорий и расчёт читались одним полотном. Мера общая на все
       разделы: компонент один. */
    <Flex as="section" className="rh-aside-section" direction="column" gap={2} style={{ marginBottom: "var(--g-spacing-7)" }}>
      <Flex gap={1} alignItems="center">
        <Text variant="subheader-2" as="h2">
          {title}
        </Text>
        {help}
      </Flex>
      {children}
    </Flex>
  );
}

/**
 * В4.6 (У22): легенда шкалы — ОДИН блок на две панели, первым в обеих.
 * На рейтинге он даёт якорь «как выглядит плохое» (на первой странице
 * диапазон 72–83, и без легенды 72 читается как провал), на карточке —
 * первый блок методической панели (вариант А компоновки кладёт её туда).
 * Слова и диапазоны — из `SCORE_SCALE`, чтобы шкала на двух экранах и в
 * MD-отчёте не разъехалась. «Нет данных» в легенду НЕ входит: это не полоса
 * шкалы, а отсутствие числа (закон 2) — про него говорит отдельная строка.
 */
export function ScoreLegend({ coverageNullBelow }: { coverageNullBelow?: number }) {
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
      <Text variant="body-1" color="complementary">
        {coverageNullBelow === undefined
          ? "При недостаточном покрытии данных оценка не рассчитывается. Отсутствующие данные не учитываются как нулевые значения."
          : `При покрытии данных ниже ${fmtCoverage(coverageNullBelow)} оценка не рассчитывается. Отсутствующие данные не учитываются как нулевые значения.`}
      </Text>
    </AsideSection>
  );
}

/**
 * Аватар репозитория: logo.url платформы, а без него или при ошибке загрузки
 * (нет сети, битая ссылка) — инициалы: внешняя картинка не обязательна для UI.
 * Тон инициалов — `avatarTone` из `format.ts`, общий с PDF-отчётом (В4.7 круг 2).
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
  return logoUrl && !failed ? (
    <Avatar size={size} shape="square" imgUrl={logoUrl} alt="" loading="lazy" style={{ flexShrink: 0 }} />
  ) : (
    <Avatar
      size={size}
      shape="square"
      text={repo}
      backgroundColor={`var(--g-color-base-${avatarTone(repo)}-light)`}
      color={`var(--g-color-text-${avatarTone(repo)})`}
      style={{ flexShrink: 0 }}
    />
  );
}

/**
 * Язык с цветной точкой, как в списках SourceCraft; цвет — language.color платформы.
 * В4.7 круг 2 (Р2.3): у известного языка без цвета платформы (на 21.09 —
 * Rich Text Format) точка нейтральная, а не пропадает — цвет не выдумывается.
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
 * В4.6 (У27): слаг репозитория — один компонент на рейтинг и карточку.
 * Пробелы вокруг слеша и обрезка по ширине решаются здесь, а не на каждом
 * экране; `title` всегда несёт полную текстовую форму из `slugOf`, чтобы
 * обрезанное имя можно было прочесть наведением.
 */
export function RepoSlug({ org, repo, variant }: { org: string; repo: string; variant: "body-1" | "subheader-1" | "subheader-2" | "header-1" }) {
  return (
    <Text variant={variant} as={variant === "header-1" ? "h1" : "span"} ellipsis title={slugOf(org, repo)} style={{ display: "block" }}>
      {org} / {repo}
    </Text>
  );
}

export function Meta({ children }: { children: ReactNode }) {
  return <div className="rh-meta">{children}</div>;
}

export function MetaItem({ icon, children, title }: { icon?: IconData; children: ReactNode; title?: string }) {
  return (
    <span className="rh-meta__item" title={title}>
      {/* Круг 1 (У37) красил мета-строку стальным `misc` — «акцент туда, где
          цвет означает». В4.6 круг 2 (Р11, замечание владельца 11) это
          ОТМЕНЕНО: на живой карточке синеватая сталь читалась как ссылки, а
          мета-строка ничего не означает — это реквизиты. Возвращён серый
          `secondary` (5,55:1 в тёмной теме, то есть и порог прозы взят).
          Компонент один на карточку и кабинет (У27: один способ набрать
          мета-строку), поэтому правка живёт здесь, а не на вызывающей стороне;
          `MePage.tsx` при этом не тронут ни строкой — он у вехи В4.7. */}
      {icon && <Icon data={icon} size={14} />}
      <Text variant="body-short" color="secondary">
        {children}
      </Text>
    </span>
  );
}

/**
 * Загрузка в форме будущего содержимого: строки нужной высоты.
 * В4.6 (У27): высоты вызывающих сторон приведены к РИТМУ того, что они
 * заменяют — строка рейтинга 56px (круг 2 вернул в неё название языка),
 * строка категории 45px, блок-полоса величины 150px. Скелетон, не
 * совпадающий с содержимым, даёт прыжок раскладки в момент загрузки — это и
 * было находкой пары.
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
 * СПРАВА, действие под текстом.
 *
 * Доводка 21.09. До неё блок стоял колонкой по центру с иконкой 48px — так не
 * сделано ни одно пустое состояние SourceCraft. У них это всегда
 * `direction="row"`, а иллюстрация заметно крупнее: замерено 120×120 на пустых
 * разделах (Pull requests, Milestones, Releases) и 100×100 на странице 404.
 * Иллюстрация у нас СВОЯ (иконка): бренд-ассеты платформы не переносим,
 * правило 3 docs/ui/gravity-uikit.md — отсюда 120px иконкой, а не картинкой.
 */
export function EmptyState({
  icon,
  title,
  description,
  actions,
}: {
  icon: IconData;
  title: string;
  description?: ReactNode;
  actions?: PlaceholderContainerActionProps[];
}) {
  return (
    <PlaceholderContainer
      className="rh-empty"
      size="m"
      align="left"
      direction="row"
      title={title}
      description={description}
      actions={actions}
      image={
        <Text color="secondary" style={{ display: "flex" }}>
          <Icon data={icon} size={120} />
        </Text>
      }
    />
  );
}
