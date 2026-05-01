import type { SupabaseClient } from "@supabase/supabase-js";

export const AGENT_NAME_POOL = [
  'Atlas', 'Pilot', 'Compass', 'Ranger', 'Scout', 'Aero',
  'Iris', 'Echo', 'Nova', 'Vega', 'Luna', 'Nyx',
  'Phoenix', 'Onyx', 'Ember', 'Zephyr', 'Cipher', 'Orion',
  'Sable', 'Halo', 'Forge', 'Tempo', 'Quill', 'Vale',
];

export function pickRandomAgentName(): string {
  return AGENT_NAME_POOL[Math.floor(Math.random() * AGENT_NAME_POOL.length)];
}

// Admin accounts always get "Isis".
export async function pickAgentName(supabase: SupabaseClient, userId: string): Promise<string> {
  const { data } = await supabase
    .from("admin_users")
    .select("user_id")
    .eq("user_id", userId)
    .maybeSingle();
  return data ? "Isis" : pickRandomAgentName();
}
