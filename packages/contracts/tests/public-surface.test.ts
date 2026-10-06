import { existsSync, readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

describe("contracts public surface", () => {
  it.each([ts.ModuleResolutionKind.Node10, ts.ModuleResolutionKind.Bundler])(
    "wizard subpath and root resolve under moduleResolution %s",
    (moduleResolution) => {
      const consumer = fileURLToPath(new URL("../../apply-kernel/src/rules/wizardIdentity.ts", import.meta.url));
      for (const [specifier, target] of [
        ["@edaix/contracts/execution-wizard", "../src/executionWizard.ts"],
        ["@edaix/contracts", "../src/index.ts"],
      ]) {
        const resolved = ts.resolveModuleName(specifier, consumer, { moduleResolution }, ts.sys).resolvedModule;
        expect(resolved, `${specifier}: resolver must find the existing shared authority`).toBeDefined();
        expect(realpathSync(resolved!.resolvedFileName)).toBe(realpathSync(fileURLToPath(new URL(target!, import.meta.url))));
      }
    },
  );

  it("pending review DTO 只从明确 draft subpath 暴露", () => {
    const root = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    const draft = readFileSync(new URL("../src/draft/index.ts", import.meta.url), "utf8");

    expect(root).not.toMatch(/account|application-profile/);
    expect(draft).toMatch(/account|application-profile|calendar/);
    for (const file of ["account.ts", "application-profile.ts"]) {
      expect(existsSync(new URL(`../src/draft/${file}`, import.meta.url)), file).toBe(true);
      expect(existsSync(new URL(`../src/${file}`, import.meta.url)), file).toBe(false);
    }
    expect(root).toContain("export * from './calendar.ts'");
    expect(readFileSync(new URL("../src/draft/calendar.ts", import.meta.url), "utf8"))
      .toContain("export * from '../calendar.ts'");
  });

  it("README 与 package export map 都明确 draft 是可显式引用的非稳定入口", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { exports: Record<string, string> };

    expect(manifest.exports["./draft"]).toBe("./src/draft/index.ts");
    expect(readme).toContain("@edaix/contracts/draft");
    expect(readme).not.toContain("不从 package export map");
  });
});
