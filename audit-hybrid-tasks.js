import { createClient } from "@supabase/supabase-js";

// Get environment variables (you'll need to set these)
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function auditHybridTasks() {
  console.log("=".repeat(80));
  console.log("AUDIT: Tasks with hybrid configuration (is_default=true AND is_regeneratable=true)");
  console.log("=".repeat(80));

  // Query 1: Tasks with hybrid configuration
  console.log("\n1. HYBRID TASKS (is_default=true AND is_regeneratable=true):");
  console.log("-".repeat(60));

  const { data: hybridTasks, error: hybridError } = await supabase
    .from("tasks")
    .select("slug, name, is_default, is_regeneratable, kind, status, output_type, plan_required")
    .eq("is_default", true)
    .eq("is_regeneratable", true)
    .order("execution_order", { ascending: true });

  if (hybridError) {
    console.error("Error fetching hybrid tasks:", hybridError);
  } else {
    console.log(`Found ${hybridTasks?.length || 0} hybrid tasks:`);
    hybridTasks?.forEach(task => {
      console.log(`  ${task.slug.padEnd(25)} | ${task.name.padEnd(30)} | ${task.kind.padEnd(12)} | ${task.status.padEnd(8)} | ${task.plan_required}`);
    });
  }

  // Query 2: All active tasks for context
  console.log("\n\n2. ALL ACTIVE TASKS (for execution order reference):");
  console.log("-".repeat(60));

  const { data: allTasks, error: allError } = await supabase
    .from("tasks")
    .select("slug, name, is_default, is_regeneratable, kind, status, plan_required, execution_order")
    .eq("status", "active")
    .order("execution_order", { ascending: true });

  if (allError) {
    console.error("Error fetching all tasks:", allError);
  } else {
    console.log(`Found ${allTasks?.length || 0} active tasks:`);
    console.log("order | slug                      | name                           | default | regen | kind         | plan");
    console.log("-".repeat(120));
    allTasks?.forEach(task => {
      const order = String(task.execution_order || 'null').padStart(5);
      const slug = task.slug.padEnd(25);
      const name = task.name.padEnd(30);
      const isDefault = task.is_default ? 'Y' : 'N';
      const isRegen = task.is_regeneratable ? 'Y' : 'N';
      const kind = task.kind.padEnd(12);
      const plan = task.plan_required;
      console.log(`${order} | ${slug} | ${name} | ${isDefault.padEnd(7)} | ${isRegen.padEnd(5)} | ${kind} | ${plan}`);
    });
  }

  console.log("\n" + "=".repeat(80));
  console.log("ANALYSIS COMPLETE");
  console.log("=".repeat(80));
}

auditHybridTasks().catch(console.error);