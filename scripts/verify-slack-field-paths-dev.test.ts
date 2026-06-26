import { describe, it, expect } from "vitest";
import { isLocalDevTokenEnabled, summarizeMembers, fieldPathPresence } from "./verify-slack-field-paths-dev.mjs";

// The live verify command is dev-only and never run in CI; this proves its guard is allowlist-shaped and its output
// carries no PII. Synthetic data only.
describe("verify-slack-field-paths-dev — allowlist guard", () => {
  it("enables ONLY in local dev + opt-in; fails closed everywhere else", () => {
    expect(isLocalDevTokenEnabled({ NODE_ENV: "development", ID_CADDIE_DEV_PROVIDER_TOKEN_SOURCE_ENABLED: "1" })).toBe(true);
    for (const env of [
      {}, { NODE_ENV: "production", ID_CADDIE_DEV_PROVIDER_TOKEN_SOURCE_ENABLED: "1" },
      { NODE_ENV: "development", VERCEL_ENV: "preview", ID_CADDIE_DEV_PROVIDER_TOKEN_SOURCE_ENABLED: "1" },
      { NODE_ENV: "development", VERCEL_ENV: "production", ID_CADDIE_DEV_PROVIDER_TOKEN_SOURCE_ENABLED: "1" },
      { NODE_ENV: "test", ID_CADDIE_DEV_PROVIDER_TOKEN_SOURCE_ENABLED: "1" },
      { NODE_ENV: "development" }, // missing opt-in
      { NODE_ENV: "development", ID_CADDIE_DEV_PROVIDER_TOKEN_SOURCE_ENABLED: "true" },
    ]) expect(isLocalDevTokenEnabled(env)).toBe(false);
  });

  it("summary + field-path report carry only counts/booleans — never emails/names/values", () => {
    const members = [
      { id: "U1", is_bot: false, deleted: false, profile: { email: "secret@x.test", real_name: "Secret Person", title: "CTO" }, tz: "UTC", has_2fa: true },
      { id: "B1", is_bot: true, profile: {} },
    ];
    const sum = summarizeMembers(members);
    expect(sum).toMatchObject({ total: 2, bots: 1, withEmail: 1, missingEmail: 1, withTitle: 1, with2fa: 1 });
    const blob = JSON.stringify(sum) + JSON.stringify(fieldPathPresence(members[0]));
    expect(blob).not.toContain("secret@x.test");
    expect(blob).not.toContain("Secret Person");
    expect(fieldPathPresence(members[0]).find((f) => f.path === "profile.email")?.present).toBe(true);
  });
});
