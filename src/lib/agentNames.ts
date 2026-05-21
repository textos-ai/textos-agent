import type { SupabaseClient } from "@supabase/supabase-js";

// Every business agent is now called "Inkthorn".
export async function pickAgentName(supabase: SupabaseClient, userId: string): Promise<string> {
  return "Inkthorn";
}
