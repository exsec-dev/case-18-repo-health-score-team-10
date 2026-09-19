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
import { SCORE_LEGEND_TITLE, SCORE_SCALE, sentence } from "./format";

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

/** Блок правой панели: заголовок subheader-2 и содержимое. */
export function AsideSection({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <Flex as="section" direction="column" gap={2} style={{ marginBottom: "var(--g-spacing-6)" }}>
      <Text variant="subheader-2" as="h2">
        {title}
      </Text>
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

export function Meta({ children }: { children: ReactNode }) {
  return <div className="rh-meta">{children}</div>;
}

export function MetaItem({ icon, children, title }: { icon?: IconData; children: ReactNode; title?: string }) {
  return (
    <span className="rh-meta__item" title={title}>
      {icon && <Icon data={icon} size={14} />}
      <Text variant="body-short" color="secondary">
        {children}
      </Text>
    </span>
  );
}

/** Загрузка в форме будущего содержимого: строки нужной высоты. */
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
