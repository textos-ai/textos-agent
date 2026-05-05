import type { SupabaseClient } from "@supabase/supabase-js";

export const AGENT_NAME_POOL = [
  'Iris', 'Linnea', 'Theia', 'Mira', 'Solène',
  'Atlas', 'Orin', 'Soren', 'Caspian', 'Aldo',
  'Sage', 'Wren',
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
