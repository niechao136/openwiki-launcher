import { describe, expect, it } from "vitest";
import { loadManifest, manifestFilePath } from "../src/manifest.mjs";

const EXPECTED_TOOL_NAMES = [
  "openwiki_list_workspaces",
  "openwiki_list_wikis",
  "openwiki_search",
  "openwiki_read",
  "openwiki_begin",
  "openwiki_submit_plan",
  "openwiki_next_page",
  "openwiki_inspect_page_claims",
  "openwiki_submit_page",
  "openwiki_finish",
];

describe("loadManifest", () => {
  it("returns null for a version that has no snapshot", () => {
    expect(loadManifest("0.0.0")).toBeNull();
  });

  it("exposes the pinned openwiki snapshot", () => {
    const manifest = loadManifest("0.6.0");

    expect(manifest.openwikiVersion).toBe("0.6.0");
    expect(manifest.serverInfo.name).toBe("openwiki");
    expect(manifest.tools.map((tool) => tool.name)).toEqual(EXPECTED_TOOL_NAMES);
    expect(typeof manifest.instructions).toBe("string");
    expect(manifest.tools.every((tool) => tool.inputSchema && tool.description)).toBe(true);
  });

  it("resolves snapshot paths inside the package", () => {
    expect(manifestFilePath("0.6.0").replace(/\\/g, "/")).toMatch(
      /manifest\/openwiki-0\.6\.0\.json$/,
    );
  });
});

describe("manifest snapshot stays in sync with the real backend", () => {
  // Gated because a cold openwiki import tree takes minutes under Defender on
  // Windows; CI and `doctor` run it explicitly, so upstream drift still fails a
  // run rather than passing unnoticed.
  it.skipIf(!process.env.LAUNCHER_REAL_SMOKE)(
    "matches the live openwiki response",
    async () => {
      const { generateManifest } = await import("../scripts/gen-manifest.mjs");

      expect(await generateManifest()).toEqual(loadManifest("0.6.0"));
    },
    600000,
  );
});
