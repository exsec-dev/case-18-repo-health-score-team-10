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
import { SCORE_LEGEND_TITLE, SCORE_SCALE, sentence, slugOf } from "./format";

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
    <Flex as="section" direction="column" gap={2} style={{ marginBottom: "var(--g-spacing-6)" }}>
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
export function ScoreLegend() {
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
      <Text variant="body-2" color="complementary">
        Нет данных – не ноль и не плохая оценка: пока источники недоступны, честного числа нет, и оценка не выставляется.
      </Text>
    </AsideSection>
  );
}

/**
 * Аватар репозитория: logo.url платформы, а без него или при ошибке загрузки
 * (нет сети, битая ссылка) — инициалы: внешняя картинка не обязательна для UI.
 */
/** Цвет инициалов по имени — стабильный, из спокойных семантических тонов темы. */
const AVATAR_TONES = ["info", "utility", "positive", "misc"] as const;

function avatarTone(name: string): (typeof AVATAR_TONES)[number] {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_TONES[h % AVATAR_TONES.length]!;
}

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

/** Язык с цветной точкой, как в списках SourceCraft; цвет — language.color платформы. */
export function LanguageName({ name, color }: { name: string | null; color: string | null }) {
  return (
    <span className="rh-lang">
      {color && <span className="rh-lang__dot" style={{ background: color }} aria-hidden="true" />}
      {name ?? "язык не определен"}
    </span>
  );
}

/**
 * В4.6 (З9): только точка языка, название — в `title`. Нужна для уплотнённой
 * строки рейтинга: цветной маркер языка там сохраняется (он же носитель
 * акцента платформы), а строка перестаёт быть двухэтажной. Без языка точка
 * не рисуется вовсе — пустого места на «неизвестно» не занимаем.
 */
export function LanguageDot({ name, color }: { name: string | null; color: string | null }) {
  if (!name) return null;
  return <span className="rh-lang__dot" style={color ? { background: color } : undefined} title={`Язык: ${name}`} />;
}

/**
 * В4.6 (У27): слаг репозитория — один компонент на рейтинг и карточку.
 * Пробелы вокруг слеша и обрезка по ширине решаются здесь, а не на каждом
 * экране; `title` всегда несёт полную текстовую форму из `slugOf`, чтобы
 * обрезанное имя можно было прочесть наведением.
 */
export function RepoSlug({ org, repo, variant }: { org: string; repo: string; variant: "subheader-1" | "header-1" }) {
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
      {/* В4.6 (У37, таблица акцентов раунда): мета-строка (лайки, форки, часы)
          берёт стальной `misc` вместо серого — акцент ставится туда, где цвет
          что-то ОЗНАЧАЕТ. Это однострочные метки с иконками, не проза: для них
          работает порог 3:1 (misc даёт 4,21:1 в тёмной и 5,59:1 в светлой),
          а правило «прозой misc не набирать» остаётся в силе. */}
      {icon && <Icon data={icon} size={14} />}
      <Text variant="body-short" color="misc">
        {children}
      </Text>
    </span>
  );
}

/**
 * Загрузка в форме будущего содержимого: строки нужной высоты.
 * В4.6 (У27): высоты вызывающих сторон приведены к РИТМУ того, что они
 * заменяют — строка рейтинга 46px, строка категории 45px, блок-полоса
 * величины 150px. Скелетон, не совпадающий с содержимым, даёт прыжок
 * раскладки в момент загрузки — это и было находкой пары.
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

/** Пустое/служебное состояние: иконка вместо иллюстрации, заголовок, действие. */
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
      size="m"
      align="center"
      direction="column"
      title={title}
      description={description}
      actions={actions}
      maxWidth={520}
      image={
        <Text color="secondary">
          <Icon data={icon} size={48} />
        </Text>
      }
    />
  );
}
