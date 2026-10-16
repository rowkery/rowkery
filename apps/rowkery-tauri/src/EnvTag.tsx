import { CONNECTION_ENVS, type ConnectionEnv } from "./types";

/** Small coloured pill: "prd", "stg", "dev", "local". */
export function EnvTag({ env }: { env: ConnectionEnv | null | undefined }) {
  if (!env) return null;
  const label = CONNECTION_ENVS.find((e) => e.value === env)?.label;
  return (
    <span data-testid="env-tag" className={`env-tag env-${env}`} title={label}>
      {env}
    </span>
  );
}
