import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  declaredOpenwikiRange, exactPinnedVersion, launcherVersion,
} from "../src/pkg.mjs";

const PKG = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

describe("版本来源", () => {
  it("包版本与 openwiki 声明都取自 package.json", () => {
    expect(launcherVersion()).toBe(PKG.version);
    expect(declaredOpenwikiRange()).toBe(PKG.dependencies.openwiki);
  });
});

describe("exactPinnedVersion", () => {
  it("接受精确锁版", () => {
    expect(exactPinnedVersion("0.6.0")).toBe("0.6.0");
    // v / = 前缀会被剥掉，返回值是归一化后的版本
    expect(exactPinnedVersion("v0.6.0")).toBe("0.6.0");
    expect(exactPinnedVersion("=0.6.0")).toBe("0.6.0");
    expect(exactPinnedVersion("0.6.0-rc.1")).toBe("0.6.0-rc.1");
  });

  it("范围声明一律返回 null —— ^0.6.0 允许 0.7.0，不是锁版", () => {
    // 这是本函数最容易写错的一处：剥掉 ^ 会把范围当锁版，
    // 于是 doctor 在一个根本没锁版的依赖上报「一致」，升级漂移悄悄溜过去。
    expect(exactPinnedVersion("^0.6.0")).toBeNull();
    expect(exactPinnedVersion("~0.6.0")).toBeNull();
    expect(exactPinnedVersion(">=0.6.0 <0.7.0")).toBeNull();
    expect(exactPinnedVersion("0.6.x")).toBeNull();
    expect(exactPinnedVersion("0.6.0 - 0.7.0")).toBeNull();
    expect(exactPinnedVersion("*")).toBeNull();
    expect(exactPinnedVersion("latest")).toBeNull();
  });

  it("非字符串与空值不抛错", () => {
    expect(exactPinnedVersion(undefined)).toBeNull();
    expect(exactPinnedVersion(null)).toBeNull();
    expect(exactPinnedVersion("")).toBeNull();
  });
});
