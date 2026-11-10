import { describe, expect, it } from "vitest";

import { signForTests, telegramName, verifyInitData } from "./verify";

const TOKEN = "123456:test-token";
const NOW = 1_800_000_000;

describe("Mini App initData", () => {
  it("accepts genuine data and reads the start parameter", async () => {
    const fields = {
      auth_date: String(NOW - 5),
      query_id: "AAH",
      start_param: "adalove",
      user: JSON.stringify({ id: 1234567, first_name: "Ada", last_name: "L", username: "ada_l" }),
    };
    const hash = await signForTests(fields, TOKEN);
    const launch = await verifyInitData(new URLSearchParams({ ...fields, hash }).toString(), TOKEN, NOW);
    expect(launch?.user.id).toBe(1234567);
    expect(launch?.startParam).toBe("adalove");
    expect(telegramName(launch!.user)).toBe("Ada L");
  });

  it("accepts data whose third-party signature was not part of the hash", async () => {
    const fields = { auth_date: String(NOW), user: JSON.stringify({ id: 7, first_name: "A" }) };
    const hash = await signForTests(fields, TOKEN);
    const data = new URLSearchParams({ ...fields, signature: "abc", hash }).toString();
    expect((await verifyInitData(data, TOKEN, NOW))?.user.id).toBe(7);
  });

  it("refuses tampered data", async () => {
    const fields = { auth_date: String(NOW), user: JSON.stringify({ id: 7, first_name: "A" }) };
    const hash = await signForTests(fields, TOKEN);
    const data = new URLSearchParams({ ...fields, user: JSON.stringify({ id: 8, first_name: "A" }), hash });
    expect(await verifyInitData(data.toString(), TOKEN, NOW)).toBeNull();
    expect(await verifyInitData("", TOKEN, NOW)).toBeNull();
  });
});
