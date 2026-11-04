// Dependency-free harness: node --test src/domain/payment-command.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { preparePaymentCommand } from "./payment-command.ts";

function prepared(text, origin = "owner_direct") {
  const result = preparePaymentCommand(text, origin);
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.payment;
}

test("three whole-command syntaxes prepare the same payment", () => {
  const canonical = prepared("◈ 10 @alice");
  for (const text of ["$MIND 10 @alice", "+10 MIND @alice"]) {
    assert.deepEqual(prepared(text), canonical);
  }
  assert.equal(canonical.amountAtomic, "10000000000");
  assert.equal(canonical.type, "payment");
  assert.equal(canonical.status, "prepared");
});

test("decimal conversion is exact, normalized and bounded to u64", () => {
  for (const [input, amount, atoms] of [
    ["0.000000001", "0.000000001", "1"],
    ["00010,120000000", "10.12", "10120000000"],
    ["9007199.254740993", "9007199.254740993", "9007199254740993"],
    ["18446744073.709551615", "18446744073.709551615", "18446744073709551615"],
  ]) {
    const payment = prepared(`◈ ${input} @alice`);
    assert.equal(payment.amount, amount);
    assert.equal(payment.amountAtomic, atoms);
    assert.equal(prepared(payment.canonicalCommand).amountAtomic, atoms);
  }
  for (const amount of ["18446744073.709551616", "18446744074", "9999999999999999999999"]) {
    assert.deepEqual(preparePaymentCommand(`◈ ${amount} @alice`, "owner_direct"), {
      ok: false,
      error: "amount_overflow",
    });
  }
  for (const amount of ["0", "000", "0,000000000"]) {
    assert.deepEqual(preparePaymentCommand(`◈ ${amount} @alice`, "owner_direct"), {
      ok: false,
      error: "zero_amount",
    });
  }
});

test("rejects signs, exponentials, rounding, thousands separators and malformed amounts", () => {
  for (const amount of [
    "-1",
    "+1",
    "1e2",
    "1E2",
    "NaN",
    "Infinity",
    "1_000",
    "1 000",
    "1,000.00",
    "1.000,00",
    ".1",
    "1.",
    "1,",
    "0.0000000001",
    "10.0000000000",
    "١٠",
  ]) {
    assert.equal(preparePaymentCommand(`◈ ${amount} @alice`, "owner_direct").ok, false, amount);
  }
});

test("requires an entire command with visible ASCII token separators", () => {
  for (const text of [
    "◈10 @alice",
    "$MIND10 @alice",
    "+ 10 MIND @alice",
    "◈ 10@alice",
    "+10MIND @alice",
    "◈\t10 @alice",
    "◈\u00a010 @alice",
    "◈ 10 @alice\n",
    "◈ 10 @alice\r\n",
    "\t◈ 10 @alice",
    "◈ 10 @alice\n◈ 20 @bob",
    "send ◈ 10 @alice",
    "◈ 10 @alice please",
    '"◈ 10 @alice"',
    "support +10 MIND @alice round:1",
    "$mind 10 @alice",
  ]) {
    assert.equal(preparePaymentCommand(text, "owner_direct").ok, false, text);
  }
  assert.equal(prepared("◈  10  @alice").canonicalCommand, "◈ 10 @alice");
  assert.equal(prepared("  +10 MIND @alice  ").canonicalCommand, "◈ 10 @alice");
});

test("accepts only canonical ASCII usernames, without inferring identities", () => {
  for (const name of ["a", "0", "a-b_c9", "a".repeat(32)]) {
    assert.equal(prepared(`◈ 1 @${name}`).recipientUsername, name);
  }
  for (const name of [
    "",
    "a".repeat(33),
    "-alice",
    "_alice",
    "Alice",
    "àlice",
    "alice.x",
    "alice@x",
    "alice/x",
    "аlice",
    "alice\u200b",
  ]) {
    assert.equal(preparePaymentCommand(`◈ 1 @${name}`, "owner_direct").ok, false, name);
  }
});

test("provenance never grants authorization, including direct owner input", () => {
  for (const origin of [
    "owner_direct",
    "ocr",
    "quotation",
    "third_party",
    "notification",
    "unknown",
  ]) {
    const payment = prepared("◈ 10 @alice", origin);
    assert.equal(payment.origin, origin);
    assert.equal(payment.authorization, "not_granted");
    assert.equal(
      payment.intent,
      origin === "owner_direct" ? "direct_instruction" : "detected_intent",
    );
    assert.equal(
      payment.previewText,
      origin === "owner_direct"
        ? "Paiement préparé : 10 ◈ à @alice."
        : "Commande repérée : 10 ◈ à @alice.",
    );
    assert.equal(Object.isFrozen(payment), true);
    assert.doesNotThrow(() => JSON.stringify(payment));
    assert.deepEqual(
      Object.keys(payment).filter((key) => /wallet|signature|network|balance/i.test(key)),
      [],
    );
  }
  for (const origin of [undefined, null, "authorized", "OWNER_DIRECT"]) {
    assert.deepEqual(preparePaymentCommand("◈ 10 @alice", origin), {
      ok: false,
      error: "invalid_origin",
    });
  }
});
