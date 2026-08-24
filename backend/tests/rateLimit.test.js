// The API-wide limits are raised out of the way for the rest of the suite
// (see jest.setup.js), so the limiter's own behaviour is covered here
// directly rather than through a mounted route.
import { jest } from "@jest/globals";
import express from "express";
import request from "supertest";
import { createRateLimiter, rateLimitMiddleware } from "../src/rateLimit.js";

describe("createRateLimiter", () => {
  test("allows up to max in a window, then reports the next call as limited", () => {
    const isLimited = createRateLimiter({ windowMs: 60_000, max: 3 });

    expect(isLimited("a")).toBe(false);
    expect(isLimited("a")).toBe(false);
    expect(isLimited("a")).toBe(false);
    expect(isLimited("a")).toBe(true);
  });

  test("counts each key separately, so one caller can't exhaust another's budget", () => {
    const isLimited = createRateLimiter({ windowMs: 60_000, max: 1 });

    expect(isLimited("a")).toBe(false);
    expect(isLimited("a")).toBe(true);
    expect(isLimited("b")).toBe(false);
  });

  test("forgets calls once they fall outside the window", () => {
    jest.useFakeTimers();
    try {
      const isLimited = createRateLimiter({ windowMs: 60_000, max: 1 });

      expect(isLimited("a")).toBe(false);
      expect(isLimited("a")).toBe(true);

      jest.advanceTimersByTime(60_001);
      expect(isLimited("a")).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  // Without the sweep this map is an unbounded cache keyed by client IP:
  // one entry per address, forever, which a spread-out flood turns into a
  // slow memory leak.
  test("drops keys that have gone quiet instead of retaining them forever", () => {
    jest.useFakeTimers();
    try {
      const isLimited = createRateLimiter({ windowMs: 1000, max: 5 });
      for (let i = 0; i < 500; i += 1) isLimited(`ip-${i}`);

      expect(isLimited.trackedKeys()).toBe(500);

      jest.advanceTimersByTime(5000);
      // Any call past the window triggers the sweep, which discards every
      // key whose calls have all aged out -- leaving only this new one.
      isLimited("still-here");
      expect(isLimited.trackedKeys()).toBe(1);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("rateLimitMiddleware", () => {
  function appWith(max) {
    const app = express();
    app.use(rateLimitMiddleware({ windowMs: 60_000, max, message: "slow down" }));
    app.get("/thing", (req, res) => res.json({ ok: true }));
    return app;
  }

  test("passes requests through under the limit", async () => {
    const app = appWith(2);
    expect((await request(app).get("/thing")).status).toBe(200);
    expect((await request(app).get("/thing")).status).toBe(200);
  });

  test("responds 429 with the configured message once over it", async () => {
    const app = appWith(1);
    await request(app).get("/thing");

    const res = await request(app).get("/thing");
    expect(res.status).toBe(429);
    expect(res.body.detail).toBe("slow down");
  });
});
