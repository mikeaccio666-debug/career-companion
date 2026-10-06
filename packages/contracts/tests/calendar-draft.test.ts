import { describe, expect, it } from "vitest";

import { CALENDAR_EVENT_PROGRESS_STATUSES } from "../src/draft/calendar";

describe("calendar draft progress contract", () => {
  it("keeps the owner-scoped progress state as an exact closed set", () => {
    expect(CALENDAR_EVENT_PROGRESS_STATUSES).toEqual([
      "NOT_STARTED",
      "DONE",
      "ARCHIVED",
    ]);
  });
});
