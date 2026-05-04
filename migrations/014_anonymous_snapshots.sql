-- Migration 014: anonymous_snapshots analytics table
-- Tracks every anonymous snapshot request for funnel analytics and abuse forensics.
-- ip_address is stored RAW — regulated data, access-restricted. See hygiene rules in anonymous.ts.
-- No retention policy, no auto-delete. Purely additive append log.

CREATE TABLE anonymous_snapshots (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  token               text        NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  source              text        NOT NULL,
  kind                business_kind NOT NULL,
  input               jsonb       NOT NULL,
  output              jsonb,
  ip_address          inet,
  user_agent          text,
  generation_ms       integer,
  status              text        NOT NULL DEFAULT 'pending',
  is_bot_suspected    boolean     NOT NULL DEFAULT false,
  claimed_at          timestamptz,
  claimed_user_id     uuid,
  claimed_business_id uuid
);

CREATE INDEX anonymous_snapshots_created_at_idx
  ON anonymous_snapshots(created_at);

CREATE INDEX anonymous_snapshots_token_idx
  ON anonymous_snapshots(token);

CREATE INDEX anonymous_snapshots_claimed_user_idx
  ON anonymous_snapshots(claimed_user_id)
  WHERE claimed_user_id IS NOT NULL;

CREATE INDEX anonymous_snapshots_source_idx
  ON anonymous_snapshots(source, created_at);
