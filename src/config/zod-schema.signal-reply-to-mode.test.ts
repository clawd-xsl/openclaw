import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./config.js";

describe("signal replyToMode schema", () => {
  it("accepts top-level Signal replyToMode", () => {
    const res = validateConfigObject({
      channels: {
        signal: {
          replyToMode: "all",
        },
      },
    });

    expect(res.ok).toBe(true);
  });
});
