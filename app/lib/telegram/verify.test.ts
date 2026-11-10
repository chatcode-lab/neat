import { describe, expect, it } from "vitest";

import { signForTests, telegramName, verifyInitData, verifyLoginWidget } from "./verify";

const TOKEN = "123456:test-token";
const NOW = 1_800_000_000;

describe("Telegram Login Widget", () => {
  it("accepts a genuine, fresh answer", async () => {
    const fields = { id: "1234567", first_name: "Ada", username: "ada_l", auth_date: String(NOW - 10) };
    const hash = await signForTests(fields, TOKEN, "widget");
    const user = await verifyLoginWidget(new URLSearchParams({ ...fields, hash }), TOKEN, NOW);
    expect(user).toEqual({ id: 1234567, firstName: "Ada", lastName: null, username: "ada_l", photoUrl: null });
  });

  it("refuses a changed, foreign or stale answer", async () => {
    const fields = { id: "1234567", first_name: "Ada", auth_date: String(NOW - 10) };
    const hash = await signForTests(fields, TOKEN, "widget");
    expect(await verifyLoginWidget(new URLSearchParams({ ...fields, id: "1", hash }), TOKEN, NOW)).toBeNull();
    expect(await verifyLoginWidget(new URLSearchParams({ ...fields, hash }), "999:other", NOW)).toBeNull();
    expect(await verifyLoginWidget(new URLSearchParams({ ...fields, hash }), TOKEN, NOW + 2 * 86400)).toBeNull();
  });
});

describe("Mini App initData", () => {
  it("accepts genuine data and reads the start parameter", async () => {
    const fields = {
      auth_date: String(NOW - 5),
      query_id: "AAH",
      start_param: "adalove",
      user: JSON.stringify({ id: 1234567, first_name: "Ada", last_name: "L", username: "ada_l" }),
    };
    const hash = await signForTests(fields, TOKEN, "webapp");
    const launch = await verifyInitData(new URLSearchParams({ ...fields, hash }).toString(), TOKEN, NOW);
    expect(launch?.user.id).toBe(1234567);
    expect(launch?.startParam).toBe("adalove");
    expect(telegramName(launch!.user)).toBe("Ada L");
  });

  it("accepts data whose third-party signature was not part of the hash", async () => {
    const fields = { auth_date: String(NOW), user: JSON.stringify({ id: 7, first_name: "A" }) };
    const hash = await signForTests(fields, TOKEN, "webapp");
    const data = new URLSearchParams({ ...fields, signature: "abc", hash }).toString();
    expect((await verifyInitData(data, TOKEN, NOW))?.user.id).toBe(7);
  });

  it("refuses tampered data", async () => {
    const fields = { auth_date: String(NOW), user: JSON.stringify({ id: 7, first_name: "A" }) };
    const hash = await signForTests(fields, TOKEN, "webapp");
    const data = new URLSearchParams({ ...fields, user: JSON.stringify({ id: 8, first_name: "A" }), hash });
    expect(await verifyInitData(data.toString(), TOKEN, NOW)).toBeNull();
    expect(await verifyInitData("", TOKEN, NOW)).toBeNull();
  });
});
