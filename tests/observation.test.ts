import assert from "node:assert/strict";
import test from "node:test";
import { diffDatabase } from "../src/observation/database.ts";
import {
  REDACTED,
  parseAndRedactBody,
  redactHeaders,
  redactJson,
  redactText,
  redactUrl,
  sanitizeHtml,
} from "../src/observation/normalize.ts";
import { createCapturePolicy, assertActionAllowed, assertUrlAllowed } from "../src/observation/policy.ts";
import type { DatabaseAdapter } from "../src/observation/schema.ts";

const adapter: DatabaseAdapter = {
  adapterVersion: "1",
  tables: {
    invoices: { primaryKey: ["tenant_id", "id"], logicalKey: ["tenant_id", "number"], scope: { tenant_id: 7 } },
  },
};

test("redacts an adversarial secret corpus while preserving useful evidence", () => {
  assert.deepEqual(
    redactJson({
      customer: "Acme",
      accessToken: "secret",
      clientSecret: "secret",
      nested: { password: "nope" },
    }),
    {
      customer: "Acme",
      accessToken: REDACTED,
      clientSecret: REDACTED,
      nested: { password: REDACTED },
    },
  );
  assert.deepEqual(
    redactHeaders({ authorization: "Bearer hidden", location: "https://a.test/callback?code=hidden", "content-type": "application/json" }),
    { location: "https://a.test/callback?code=%5BREDACTED%5D", "content-type": "application/json" },
  );
  assert.equal(
    redactUrl("https://user:pass@example.test/token/abc?code=ok&X-Amz-Signature=hidden#secret"),
    "https://%5BREDACTED%5D:%5BREDACTED%5D@example.test/token/%5BREDACTED%5D?code=%5BREDACTED%5D&X-Amz-Signature=%5BREDACTED%5D#[REDACTED]",
  );
  assert.deepEqual(parseAndRedactBody("email=a%40example.com&password=hidden"), {
    email: "a@example.com",
    password: REDACTED,
  });
  assert.equal(
    redactText('{"clientSecret":"hidden","safe":"ok"}'),
    `{"clientSecret":"${REDACTED}","safe":"ok"}`,
  );
  assert.match(
    sanitizeHtml('<input value="hidden" type="password"><textarea name="clientSecret">hidden</textarea>'),
    /\[REDACTED\]/,
  );
  assert.doesNotMatch(
    sanitizeHtml('<input value="hidden" type="password"><textarea name="clientSecret">hidden</textarea>'),
    />hidden</,
  );
});

test("uses adapter-defined composite and logical identities", () => {
  const before = {
    tables: {
      invoices: [
        { tenant_id: 7, id: 1, number: "INV-1", status: "draft" },
        { tenant_id: 7, id: 2, number: "INV-2", status: "draft" },
        { tenant_id: 8, id: 1, number: "OTHER", status: "draft" },
      ],
    },
  };
  const after = {
    tables: {
      invoices: [
        { tenant_id: 7, id: 1, number: "INV-1", status: "sent" },
        { tenant_id: 7, id: 3, number: "INV-3", status: "draft" },
        { tenant_id: 8, id: 1, number: "OTHER", status: "sent" },
      ],
    },
  };
  const changes = diffDatabase(before, after, adapter);
  assert.deepEqual(
    changes.map(({ operation, primaryIdentity, logicalIdentity }) => ({ operation, primaryIdentity, logicalIdentity })),
    [
      {
        operation: "update",
        primaryIdentity: { tenant_id: 7, id: 1 },
        logicalIdentity: { tenant_id: 7, number: "INV-1" },
      },
      {
        operation: "delete",
        primaryIdentity: { tenant_id: 7, id: 2 },
        logicalIdentity: { tenant_id: 7, number: "INV-2" },
      },
      {
        operation: "insert",
        primaryIdentity: { tenant_id: 7, id: 3 },
        logicalIdentity: { tenant_id: 7, number: "INV-3" },
      },
    ],
  );
});

test("rejects duplicate configured primary identities", () => {
  const duplicate = {
    tables: {
      invoices: [
        { tenant_id: 7, id: 1, number: "INV-1" },
        { tenant_id: 7, id: 1, number: "INV-2" },
      ],
    },
  };
  assert.throws(() => diffDatabase({ tables: { invoices: [] } }, duplicate, adapter), /duplicate configured primary identity/);
});

test("enforces origin and action-risk policy", () => {
  const policy = createCapturePolicy({
    sourceUrl: "https://app.example.test",
    tenant: "sandbox",
    identity: "operator",
  });
  assert.doesNotThrow(() => assertUrlAllowed("https://app.example.test/projects", policy.allowedOrigins));
  assert.throws(() => assertUrlAllowed("https://evil.example/projects", policy.allowedOrigins), /outside capture policy/);
  assert.throws(
    () => assertActionAllowed({ kind: "click", risk: "destructive", target: { role: "button", name: "Delete" } }, policy),
    /exceeds policy maximum/,
  );
});
