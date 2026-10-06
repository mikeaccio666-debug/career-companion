import { createViewContext } from "../assistant/app/view-context";
import { shortView, fillView } from "../assistant/app/materials-view";
import { panelDimensions } from "../assistant/shell/geometry";
import { it, expect, vi } from "vitest";
import { createAssistantController } from "../assistant/app/controller";
import { createReadOnlyPorts } from "../assistant/features/session/read-only-ports";
import { initialAssistantState } from "../assistant/state/initial";
import { previewData } from "../assistant/testing/fixtures";
import {
  createCommerceFixture,
  COMMERCE_FIXTURE_ROLE as role,
  COMMERCE_FIXTURE_RESUME as resume,
} from "../assistant/testing/commerce-fixture";
import { createAutofillFixture } from "../assistant/testing/autofill-fixture";
it("selects the prepared Mission, requires explicit confirmation and never restarts on recheck", async () => {
  const commerce = createCommerceFixture(),
    autofill = createAutofillFixture(),
    execute = vi.fn(autofill.execute);
  const ok = async () => ({ ok: true as const, value: undefined });
  const ui = createAssistantController(
    previewData,
    {
      ...createReadOnlyPorts({ login: ok, logout: ok, refresh: ok }),
      commerce: commerce.ports,
      autofill: { execute },
    },
    {
      ...initialAssistantState(previewData, {
        persona: "connected",
        entitlements: {
          jobs: { access: "granted" },
          ats: { access: "granted" },
          letters: { access: "granted" },
          chat: { access: "granted" },
          voice: { access: "granted" },
        },
      }),
      session: "connected",
      currentTargetId: role,
    },
  );
  await ui.dispatch("discover");
  await ui.dispatch("deck-accept");
  await ui.dispatch("open-shortlist");
  await ui.dispatch("material-select", `existing:${resume}`);
  await ui.dispatch("prepare");
  const id = commerce.entry().id;
  const view = () =>
    createViewContext(
      ui.ctx.state,
      ui.ctx.data,
      panelDimensions("shortlist", { width: 1280, height: 900 }),
    );
  expect(shortView(view()).items.find((item) => item.id === id)?.openable).toBe(
    true,
  );
  await ui.dispatch("open-job-page", id);
  expect(ui.ctx.state.scene).toBe("autofill");
  expect(execute.mock.calls.some((c) => c[0] === "START")).toBe(false);
  await ui.dispatch("fill-start");
  expect(ui.ctx.state.sheet?.kind).toBe("fill");
  await ui.dispatch("fill-confirm");
  expect(ui.ctx.state.autofill?.snapshot?.rows.map((r) => r.state)).toEqual([
    "READBACK_CONFIRMED",
    "PRESERVED",
    "MANUAL",
    "FAILED",
  ]);
  expect(fillView(view()).progress).toBe("1 / 4");
  expect(fillView(view()).rows.map((row) => row.mark)).toEqual([
    "✓",
    "=",
    "!",
    "×",
  ]);
  await ui.dispatch("fill-rerun");
  expect(execute.mock.calls.filter((c) => c[0] === "START")).toHaveLength(1);
  ui.dispose();
});
