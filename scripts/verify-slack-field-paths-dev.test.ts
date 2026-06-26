import { describe, it, expect } from "vitest";
import { isLocalDevTokenEnabled, summarizeMembers, fieldPathPresence, pickSampledNonBot } from "./verify-slack-field-paths-dev.mjs";

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
    expect(sum).toMatchObject({ total: 2, bots: 1, nonBots: 1, usersWithEmail: 1, nonBotsWithEmail: 1, botsWithEmail: 0, withTitle: 1, with2fa: 1 });
    const blob = JSON.stringify(sum) + JSON.stringify(fieldPathPresence(members[0])) + JSON.stringify(pickSampledNonBot(members));
    expect(blob).not.toContain("secret@x.test");
    expect(blob).not.toContain("Secret Person");
  });

  it("email is broken down by user type — a BOT-only email does NOT count as nonBotsWithEmail (the #188 ambiguity)", () => {
    const members = [
      { id: "B1", is_bot: true, profile: { email: "bot@x.test" } }, // bot WITH email
      { id: "USLACKBOT", is_bot: false, profile: { email: "slackbot@x.test" } }, // USLACKBOT treated as bot
      { id: "U1", is_bot: false, profile: {} }, // non-bot WITHOUT email
    ];
    const sum = summarizeMembers(members);
    expect(sum).toMatchObject({ total: 3, bots: 2, nonBots: 1, usersWithEmail: 2, botsWithEmail: 2, nonBotsWithEmail: 0, nonBotsMissingEmail: 1 });
    const picked = pickSampledNonBot(members);
    expect(picked.sampledNonBotWithEmailFound).toBe(false); // no non-bot has email → merge gate NOT met
    expect(picked.sampledNonBotHasEmail).toBe(false);
    expect(JSON.stringify(picked)).not.toContain("@x.test"); // returns booleans only — no raw member/email
  });

  it("prefers a non-bot WITH email for the sample (merge-gate evidence) and returns NO raw member", () => {
    const members = [
      { id: "U_NOEMAIL", is_bot: false, profile: {} },
      { id: "U_EMAIL", is_bot: false, profile: { email: "real@x.test" }, tz: "UTC" },
      { id: "B1", is_bot: true, profile: { email: "bot@x.test" } },
    ];
    const picked = pickSampledNonBot(members);
    expect(picked.sampledNonBotWithEmailFound).toBe(true);
    expect(picked.sampledNonBotHasEmail).toBe(true);
    // proves it picked the with-email non-bot (email PRESENT in the booleans-only field-path block)…
    expect(picked.fieldPaths.find((f: { path: string; present: boolean }) => f.path === "profile.email")?.present).toBe(true);
    // …and leaks no raw member/email value:
    expect(JSON.stringify(picked)).not.toContain("real@x.test");
    expect(JSON.stringify(picked)).not.toContain("U_EMAIL");
  });
});
