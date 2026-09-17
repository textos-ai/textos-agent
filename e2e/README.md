# TrustLight end-to-end suites

These run against the **deployed test Worker** over real HTTP, and against the
real Supabase database. They are tracked here rather than in `scripts/` — which
is gitignored — because they are the only verification that the public API does
not leak, and that verification should not live on one machine.

## Running them

Credentials are read at runtime from `C:/code/textos-agent/.dev.vars`. Nothing
here embeds a key, and nothing should ever be added that does.

```bash
node e2e/e2e-trustlight-api.mjs        # the public directory API
node e2e/e2e-vetting-api.mjs           # vetting queue + the nine-check gate
node e2e/e2e-campaign.mjs              # comped campaign, notify email, removal
```

## They write to real rows

Each suite promotes real leads into vetting states, asserts, then restores
every column it touched and verifies the restoration. Two things matter:

1. **Every column a fixture writes must be in that suite's `TOUCHED` list**, or
   the restore misses it and the run leaves residue on a real business. This
   has already happened once: a licence number was left behind on a live lead,
   and the application endpoint matches on licence numbers.
2. They select `vetting_status = 'lead'` rows. Confirm the subjects before a
   run if the lead pool has changed.

## What the negative assertions are for

The ones that matter most are the negatives — that a business mid-verification
is invisible, that a failed one is not publicly identifiable, and that no PII
crosses the boundary. Those check the RAW response text, not a parsed object,
so a leak anywhere in the payload is caught.

Contact details (phone, website, address, Google profile) are published on
`/api/contractor/:slug` and **must never** appear on `/featured` or `/search`.
`contact_email`, `contact_name`, `phone_e164_digits`, `license_number`,
`gl_carrier` and check notes must never appear anywhere.
