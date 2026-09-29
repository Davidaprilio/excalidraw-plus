-- Two-factor authentication (TOTP) and passkeys (WebAuthn)

ALTER TABLE users
  -- AES-256-GCM encrypted base32 secrets (see src/utils/crypto.ts)
  ADD COLUMN IF NOT EXISTS totp_secret TEXT,
  ADD COLUMN IF NOT EXISTS totp_pending_secret TEXT,
  ADD COLUMN IF NOT EXISTS totp_enabled_at TIMESTAMPTZ,
  -- last accepted 30s time step, so a code can't be used twice
  ADD COLUMN IF NOT EXISTS totp_last_step BIGINT;

-- One-time recovery codes (sha256 hashes)
CREATE TABLE IF NOT EXISTS user_recovery_codes (
  id SERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_recovery_codes_user ON user_recovery_codes(user_id);

CREATE TABLE IF NOT EXISTS webauthn_credentials (
  id TEXT PRIMARY KEY, -- credential id (base64url)
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key BYTEA NOT NULL,
  counter BIGINT NOT NULL DEFAULT 0,
  transports TEXT[],
  device_type VARCHAR(32),
  backed_up BOOLEAN,
  name VARCHAR(100) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_used_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_webauthn_credentials_user ON webauthn_credentials(user_id);

-- Challenges / MFA tokens already redeemed (they are signed and short-lived,
-- this makes them single use)
CREATE TABLE IF NOT EXISTS used_auth_challenges (
  challenge TEXT PRIMARY KEY,
  used_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
