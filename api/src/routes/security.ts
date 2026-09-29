import { Router, Response } from "express";
import bcrypt from "bcryptjs";
import * as OTPAuth from "otpauth";
import QRCode from "qrcode";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransport,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { query, queryOne, withTransaction } from "../db";
import { authMiddleware, AuthRequest, signPurposeToken, verifyPurposeToken } from "../middleware/auth";
import { serverError } from "../utils/http";
import { consumeChallenge, issueSession } from "../utils/session";
import { createFailureLimiter } from "../utils/rateLimit";
import {
  decryptSecret,
  encryptSecret,
  generateRecoveryCode,
  normalizeRecoveryCode,
  sha256,
} from "../utils/crypto";

// Two-factor authentication (TOTP + recovery codes) and passkeys (WebAuthn).
// Mounted at /api/auth next to the password routes.
const router = Router();

const ISSUER = "Excalidraw Plus";
const RECOVERY_CODE_COUNT = 10;
// Origins the app is served from (comma separated); the passkey RP ID is their host
const ORIGINS = (process.env.APP_ORIGIN || "http://localhost:4000").split(",").map((o) => o.trim());
const RP_ID = new URL(ORIGINS[0]).hostname;

// 5 wrong second-factor codes per user per 10 minutes
const mfaLimiter = createFailureLimiter(5, 10 * 60 * 1000);

const makeTotp = (secretBase32: string, label: string) =>
  new OTPAuth.TOTP({
    issuer: ISSUER,
    label,
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secretBase32),
  });

/** Time step of a valid code, or null. Allows one step of clock drift. */
const totpStep = (secretBase32: string, code: unknown): number | null => {
  if (typeof code !== "string" || !/^\d{6}$/.test(code.replace(/\s/g, ""))) {
    return null;
  }
  const delta = makeTotp(secretBase32, "").validate({ token: code.replace(/\s/g, ""), window: 1 });
  return delta === null ? null : Math.floor(Date.now() / 30000) + delta;
};

const checkPassword = async (userId: string, password: unknown) => {
  const user = await queryOne("SELECT password_hash FROM users WHERE id = $1", [userId]);
  return !!user && typeof password === "string" && bcrypt.compare(password, user.password_hash);
};

async function replaceRecoveryCodes(userId: string): Promise<string[]> {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, generateRecoveryCode);
  await withTransaction(async (client) => {
    await client.query("DELETE FROM user_recovery_codes WHERE user_id = $1", [userId]);
    for (const code of codes) {
      await client.query("INSERT INTO user_recovery_codes (user_id, code_hash) VALUES ($1, $2)", [
        userId,
        sha256(normalizeRecoveryCode(code)),
      ]);
    }
  });
  return codes;
}

// ---- Overview ----

router.get("/security", authMiddleware, async (req: AuthRequest, res) => {
  try {
    const user = await queryOne(
      `SELECT totp_enabled_at,
              (SELECT COUNT(*)::int FROM user_recovery_codes r WHERE r.user_id = u.id AND r.used_at IS NULL)
                as recovery_codes_remaining
       FROM users u WHERE id = $1`,
      [req.userId]
    );
    const passkeys = await query(
      `SELECT id, name, device_type, backed_up, created_at, last_used_at
       FROM webauthn_credentials WHERE user_id = $1 ORDER BY created_at`,
      [req.userId]
    );
    res.json({
      totp: {
        enabled: !!user.totp_enabled_at,
        enabledAt: user.totp_enabled_at,
        recoveryCodesRemaining: user.recovery_codes_remaining,
      },
      passkeys,
    });
  } catch (err: any) {
    serverError(res, err);
  }
});

// ---- TOTP ----

// Start setup: a new secret, confirmed by /mfa/totp/enable
router.post("/mfa/totp/setup", authMiddleware, async (req: AuthRequest, res) => {
  try {
    const user = await queryOne("SELECT email, totp_secret FROM users WHERE id = $1", [req.userId]);
    if (user.totp_secret) {
      return res.status(400).json({ error: "Two-factor authentication is already on" });
    }
    const secret = new OTPAuth.Secret({ size: 20 }).base32;
    await query("UPDATE users SET totp_pending_secret = $1 WHERE id = $2", [encryptSecret(secret), req.userId]);
    const uri = makeTotp(secret, user.email).toString();
    res.json({ secret, uri, qr: await QRCode.toDataURL(uri, { margin: 1, width: 220 }) });
  } catch (err: any) {
    serverError(res, err);
  }
});

// Confirm setup with a code from the app; returns the recovery codes (shown once)
router.post("/mfa/totp/enable", authMiddleware, async (req: AuthRequest, res) => {
  try {
    const user = await queryOne("SELECT totp_pending_secret, totp_secret FROM users WHERE id = $1", [req.userId]);
    if (user.totp_secret) {
      return res.status(400).json({ error: "Two-factor authentication is already on" });
    }
    if (!user.totp_pending_secret) {
      return res.status(400).json({ error: "Start the setup first" });
    }
    const step = totpStep(decryptSecret(user.totp_pending_secret), req.body.code);
    if (step === null) {
      return res.status(400).json({ error: "That code isn't valid. Check your authenticator app and try again." });
    }
    await query(
      `UPDATE users SET totp_secret = totp_pending_secret, totp_pending_secret = NULL,
         totp_enabled_at = NOW(), totp_last_step = $2
       WHERE id = $1`,
      [req.userId, step]
    );
    res.json({ recoveryCodes: await replaceRecoveryCodes(req.userId!) });
  } catch (err: any) {
    serverError(res, err);
  }
});

router.post("/mfa/totp/disable", authMiddleware, async (req: AuthRequest, res) => {
  try {
    if (!(await checkPassword(req.userId!, req.body.password))) {
      return res.status(400).json({ error: "The password is incorrect" });
    }
    await withTransaction(async (client) => {
      await client.query(
        `UPDATE users SET totp_secret = NULL, totp_pending_secret = NULL, totp_enabled_at = NULL,
           totp_last_step = NULL
         WHERE id = $1`,
        [req.userId]
      );
      await client.query("DELETE FROM user_recovery_codes WHERE user_id = $1", [req.userId]);
    });
    res.json({ ok: true });
  } catch (err: any) {
    serverError(res, err);
  }
});

router.post("/mfa/recovery-codes", authMiddleware, async (req: AuthRequest, res) => {
  try {
    const user = await queryOne("SELECT totp_secret FROM users WHERE id = $1", [req.userId]);
    if (!user.totp_secret) {
      return res.status(400).json({ error: "Two-factor authentication is off" });
    }
    if (!(await checkPassword(req.userId!, req.body.password))) {
      return res.status(400).json({ error: "The password is incorrect" });
    }
    res.json({ recoveryCodes: await replaceRecoveryCodes(req.userId!) });
  } catch (err: any) {
    serverError(res, err);
  }
});

// Second step of a password login: { mfaToken, code } or { mfaToken, recoveryCode }
router.post("/login/mfa", async (req, res) => {
  try {
    const token = verifyPurposeToken<{ userId: string; nonce: string }>(req.body.mfaToken, "mfa");
    if (!token) {
      return res.status(401).json({ error: "The sign-in expired. Please sign in again." });
    }
    if (mfaLimiter.isBlocked(token.userId)) {
      return res.status(429).json({ error: "Too many wrong codes. Try again in a few minutes." });
    }
    const user = await queryOne("SELECT totp_secret, totp_last_step FROM users WHERE id = $1", [token.userId]);
    if (!user?.totp_secret) {
      return res.status(401).json({ error: "The sign-in expired. Please sign in again." });
    }

    let ok = false;
    if (req.body.recoveryCode) {
      ok = !!(await queryOne(
        `UPDATE user_recovery_codes SET used_at = NOW()
         WHERE id = (SELECT id FROM user_recovery_codes
                     WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL LIMIT 1)
         RETURNING id`,
        [token.userId, sha256(normalizeRecoveryCode(String(req.body.recoveryCode)))]
      ));
    } else {
      const step = totpStep(decryptSecret(user.totp_secret), req.body.code);
      // a code is valid once: reject steps at or before the last accepted one
      if (step !== null && (user.totp_last_step === null || step > Number(user.totp_last_step))) {
        await query("UPDATE users SET totp_last_step = $2 WHERE id = $1", [token.userId, step]);
        ok = true;
      }
    }
    if (!ok) {
      mfaLimiter.fail(token.userId);
      return res.status(400).json({ error: "That code isn't valid" });
    }
    if (!(await consumeChallenge(`mfa:${token.nonce}`))) {
      return res.status(401).json({ error: "The sign-in expired. Please sign in again." });
    }
    mfaLimiter.reset(token.userId);
    res.json(await issueSession(token.userId));
  } catch (err: any) {
    serverError(res, err);
  }
});

// ---- Passkeys ----

const PASSKEY_COLUMNS = "id, name, device_type, backed_up, created_at, last_used_at";

router.post("/passkeys/register/options", authMiddleware, async (req: AuthRequest, res) => {
  try {
    const user = await queryOne("SELECT email, name FROM users WHERE id = $1", [req.userId]);
    const existing = await query("SELECT id, transports FROM webauthn_credentials WHERE user_id = $1", [req.userId]);
    const options = await generateRegistrationOptions({
      rpName: ISSUER,
      rpID: RP_ID,
      userName: user.email,
      userDisplayName: user.name || user.email,
      userID: new TextEncoder().encode(req.userId),
      attestationType: "none",
      // don't register the same authenticator twice
      excludeCredentials: existing.map((c) => ({
        id: c.id,
        transports: (c.transports ?? undefined) as AuthenticatorTransport[] | undefined,
      })),
      // discoverable, so it can sign in without typing the email
      authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
    });
    res.json({
      options,
      challengeToken: signPurposeToken("webauthn-register", { userId: req.userId, challenge: options.challenge }),
    });
  } catch (err: any) {
    serverError(res, err);
  }
});

router.post("/passkeys/register/verify", authMiddleware, async (req: AuthRequest, res) => {
  try {
    const token = verifyPurposeToken<{ userId: string; challenge: string }>(
      req.body.challengeToken,
      "webauthn-register"
    );
    if (!token || token.userId !== req.userId) {
      return res.status(400).json({ error: "The request expired, please try again" });
    }
    const verification = await verifyRegistrationResponse({
      response: req.body.response as RegistrationResponseJSON,
      expectedChallenge: token.challenge,
      expectedOrigin: ORIGINS,
      expectedRPID: RP_ID,
      requireUserVerification: false,
    }).catch(() => null);
    if (!verification?.verified || !verification.registrationInfo) {
      return res.status(400).json({ error: "The passkey couldn't be verified" });
    }
    if (!(await consumeChallenge(`webauthn:${token.challenge}`))) {
      return res.status(400).json({ error: "The request expired, please try again" });
    }
    const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
    const name = typeof req.body.name === "string" && req.body.name.trim() ? req.body.name.trim() : "Passkey";
    const passkey = await queryOne(
      `INSERT INTO webauthn_credentials (id, user_id, public_key, counter, transports, device_type, backed_up, name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING ${PASSKEY_COLUMNS}`,
      [
        credential.id,
        req.userId,
        Buffer.from(credential.publicKey),
        credential.counter,
        credential.transports ?? null,
        credentialDeviceType,
        credentialBackedUp,
        name.slice(0, 100),
      ]
    );
    res.status(201).json({ passkey });
  } catch (err: any) {
    serverError(res, err);
  }
});

const ownedPasskey = async (req: AuthRequest, res: Response) => {
  const passkey = await queryOne("SELECT id FROM webauthn_credentials WHERE id = $1 AND user_id = $2", [
    req.params.id,
    req.userId,
  ]);
  if (!passkey) {
    res.status(404).json({ error: "Passkey not found" });
  }
  return passkey;
};

router.patch("/passkeys/:id", authMiddleware, async (req: AuthRequest, res) => {
  try {
    const name = typeof req.body.name === "string" ? req.body.name.trim() : "";
    if (!name) {
      return res.status(400).json({ error: "Name is required" });
    }
    if (!(await ownedPasskey(req, res))) return;
    const passkey = await queryOne(
      `UPDATE webauthn_credentials SET name = $1 WHERE id = $2 RETURNING ${PASSKEY_COLUMNS}`,
      [name.slice(0, 100), req.params.id]
    );
    res.json({ passkey });
  } catch (err: any) {
    serverError(res, err);
  }
});

router.delete("/passkeys/:id", authMiddleware, async (req: AuthRequest, res) => {
  try {
    if (!(await ownedPasskey(req, res))) return;
    await query("DELETE FROM webauthn_credentials WHERE id = $1", [req.params.id]);
    res.json({ ok: true });
  } catch (err: any) {
    serverError(res, err);
  }
});

// Passwordless sign-in. A passkey is itself strong (possession + device unlock),
// so it isn't followed by the TOTP step.
router.post("/passkeys/login/options", async (_req, res) => {
  try {
    const options = await generateAuthenticationOptions({ rpID: RP_ID, userVerification: "preferred" });
    res.json({ options, challengeToken: signPurposeToken("webauthn-login", { challenge: options.challenge }) });
  } catch (err: any) {
    serverError(res, err);
  }
});

router.post("/passkeys/login/verify", async (req, res) => {
  try {
    const token = verifyPurposeToken<{ challenge: string }>(req.body.challengeToken, "webauthn-login");
    const response = req.body.response as AuthenticationResponseJSON;
    if (!token || typeof response?.id !== "string") {
      return res.status(400).json({ error: "The request expired, please try again" });
    }
    const stored = await queryOne("SELECT * FROM webauthn_credentials WHERE id = $1", [response.id]);
    if (!stored) {
      return res.status(400).json({ error: "This passkey isn't registered to any account" });
    }
    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: token.challenge,
      expectedOrigin: ORIGINS,
      expectedRPID: RP_ID,
      requireUserVerification: false,
      credential: {
        id: stored.id,
        publicKey: new Uint8Array(stored.public_key),
        counter: Number(stored.counter),
        transports: stored.transports ?? undefined,
      },
    }).catch(() => null);
    if (!verification?.verified) {
      return res.status(400).json({ error: "The passkey couldn't be verified" });
    }
    if (!(await consumeChallenge(`webauthn:${token.challenge}`))) {
      return res.status(400).json({ error: "The request expired, please try again" });
    }
    await query("UPDATE webauthn_credentials SET counter = $2, last_used_at = NOW() WHERE id = $1", [
      stored.id,
      verification.authenticationInfo.newCounter,
    ]);
    res.json(await issueSession(stored.user_id));
  } catch (err: any) {
    serverError(res, err);
  }
});

export default router;
