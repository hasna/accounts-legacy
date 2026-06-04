import type { Profile, ToolDef } from "../types.js";

function renderTemplate(value: string, profile: Profile): string {
  return value.replaceAll("{profileDir}", profile.dir).replaceAll("{profileName}", profile.name).replaceAll("{toolId}", profile.tool);
}

export function profileEnv(profile: Profile, tool: ToolDef): Record<string, string> {
  const env: Record<string, string> = {
    [tool.envVar]: profile.dir,
  };
  for (const [name, value] of Object.entries(tool.extraEnv ?? {})) {
    env[name] = renderTemplate(value, profile);
  }
  return env;
}

export function formatEnvAssignments(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([name, value]) => `${name}=${JSON.stringify(value)}`)
    .join(" ");
}

export function formatExportLines(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([name, value]) => `export ${name}=${JSON.stringify(value)}`)
    .join("\n");
}
