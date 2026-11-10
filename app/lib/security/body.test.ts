import { describe, expect, it } from "vitest";

import { BODY_LIMIT, UPLOAD_BODY_LIMIT, bodyLimit, capRequestBody } from "./body";

/** A streamed form body with no declared length, counting how much of it is read. */
function streamedForm(chunks: number, chunkSize: number) {
  const read = { bytes: 0 };
  let sent = 0;
  const chunk = new TextEncoder().encode(`pad=${"a".repeat(chunkSize - 4)}`.slice(0, chunkSize));
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent === chunks) return controller.close();
      sent += 1;
      read.bytes += chunk.byteLength;
      controller.enqueue(sent === 1 ? new TextEncoder().encode("next=%2Fapp&") : chunk);
    },
  });
  const request = new Request("https://neat.link/signin", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    duplex: "half",
  } as RequestInit);
  return { request, read };
}

describe("request body cap", () => {
  it("lets a body within the limit through whole", async () => {
    const { request } = streamedForm(3, 1024);
    const capped = capRequestBody(request, 8 * 1024);
    expect((await capped.request.formData()).get("next")).toBe("/app");
    expect(capped.overLimit()).toBe(false);
  });

  it("stops reading a body that passes the limit, declared or not", async () => {
    const { request, read } = streamedForm(10_000, 1024);
    const capped = capRequestBody(request, 16 * 1024);
    await expect(capped.request.formData()).rejects.toThrow();
    expect(capped.overLimit()).toBe(true);
    // Read up to the limit and a little ahead, never the whole 10 MB.
    expect(read.bytes).toBeLessThan(64 * 1024);
  });

  it("allows pictures only where they are uploaded", () => {
    expect(bodyLimit("/app/sites/ada")).toBe(UPLOAD_BODY_LIMIT);
    expect(bodyLimit("/app/sites/ada.data")).toBe(UPLOAD_BODY_LIMIT);
    expect(bodyLimit("/api/v1/sites/ada/picture")).toBe(UPLOAD_BODY_LIMIT);
    expect(bodyLimit("/signin")).toBe(BODY_LIMIT);
    expect(bodyLimit("/app/settings")).toBe(BODY_LIMIT);
    expect(bodyLimit("/mcp")).toBe(BODY_LIMIT);
  });
});
