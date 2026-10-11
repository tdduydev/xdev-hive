import { useQuery } from "@tanstack/react-query";
import { healthLabel } from "./lib/health.ts";
import { orpc } from "./lib/rpc.ts";

export function App() {
  const health = useQuery(orpc.system.health.queryOptions());
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-3 px-4 py-16">
      <h1 className="text-3xl font-semibold tracking-tight">xDev Hive</h1>
      <p className="text-muted">{healthLabel(health)}</p>
    </main>
  );
}
