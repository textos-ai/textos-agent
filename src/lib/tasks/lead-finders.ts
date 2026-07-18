// The lead-search finders the pipeline runs, in order — ONE source of truth for
// both run-lead-search (what to execute) and the leads API (which platforms to
// name in the UI: "Searched: Reddit", the live progress meter).
//
// Add a finder here (with its retrieval task + external_apis row) and it BOTH
// runs in the pipeline AND shows up in the leads UI automatically — no other
// code changes. Wave 1 conversation platforms: Reddit + Hacker News (same
// post.* shape). Google News was trialed but returned publications (not
// contactable people), so it's deactivated; its rows remain for future use.
export const LEAD_FINDER_SLUGS: string[] = [
  "reddit-find-conversations",
  "hackernews-find-conversations",
];
