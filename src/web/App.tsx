// App.tsx — В3-скаффолд: оболочка страницы + живой /api/health.
// Рейтинг и страница репо растут здесь (В3).
import { Flex, Label, Link, Loader, Text } from "@gravity-ui/uikit";
import { useEffect, useState } from "react";

type Health = { ok: boolean; repos: number; llmProvider: string };
type HealthState = { kind: "loading" } | { kind: "ok"; health: Health } | { kind: "error"; message: string };

export function App() {
  const [state, setState] = useState<HealthState>({ kind: "loading" });

  useEffect(() => {
    fetch("/api/health")
      .then((r) => (r.ok ? (r.json() as Promise<Health>) : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((health) => setState({ kind: "ok", health }))
      .catch((e: unknown) => setState({ kind: "error", message: e instanceof Error ? e.message : String(e) }));
  }, []);

  return (
    <Flex direction="column" gap={4} style={{ padding: "var(--g-spacing-8)", maxWidth: 960, margin: "0 auto" }}>
      <Text variant="header-2" as="h1">
        SourceCraft Repo Health
      </Text>
      <Text color="secondary">В3 — скаффолд. Рейтинг и страницы анализа появятся здесь.</Text>
      <Flex gap={2} alignItems="center">
        {state.kind === "loading" && <Loader size="s" />}
        {state.kind === "ok" && (
          <>
            <Label theme="success">сервер жив</Label>
            <Label theme="normal">репо в БД: {state.health.repos}</Label>
            <Label theme="info">llm: {state.health.llmProvider}</Label>
          </>
        )}
        {state.kind === "error" && <Label theme="danger">health: {state.message}</Label>}
        <Link href="/api/health">/api/health</Link>
      </Flex>
    </Flex>
  );
}
