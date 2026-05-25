import { describe, expect, it } from "vitest";

import { isSupportedBenchmark } from "./supportedBenchmarks";

describe("isSupportedBenchmark", () => {
  it("accepts the exact tested name/version pairs", () => {
    expect(
      isSupportedBenchmark("CIS Microsoft Intune for Windows 11 Benchmark", "v4.0.0"),
    ).toBe(true);
    expect(
      isSupportedBenchmark("CIS Microsoft Intune for Windows 11 Benchmark", "v3.0.1"),
    ).toBe(true);
    expect(
      isSupportedBenchmark("CIS Microsoft Windows 11 Enterprise Benchmark", "v5.0.1"),
    ).toBe(true);
    expect(
      isSupportedBenchmark("CIS Microsoft Windows 11 Stand-alone Benchmark", "v5.0.0"),
    ).toBe(true);
    expect(
      isSupportedBenchmark("CIS Microsoft Windows 10 Stand-alone Benchmark", "v3.0.0"),
    ).toBe(true);
  });

  it("normalizes surrounding and repeated whitespace before matching", () => {
    expect(
      isSupportedBenchmark("  CIS Microsoft  Windows 11   Enterprise Benchmark ", "v5.0.1"),
    ).toBe(true);
  });

  it("rejects a tested benchmark at an untested version", () => {
    expect(
      isSupportedBenchmark("CIS Microsoft Windows 11 Enterprise Benchmark", "v5.0.2"),
    ).toBe(false);
  });

  it("rejects a benchmark outside the tested set", () => {
    expect(
      isSupportedBenchmark("CIS Microsoft Windows Server 2022 Benchmark", "v3.0.0"),
    ).toBe(false);
  });

  it("treats an empty name or version as unsupported", () => {
    expect(isSupportedBenchmark("", "v4.0.0")).toBe(false);
    expect(
      isSupportedBenchmark("CIS Microsoft Windows 11 Enterprise Benchmark", ""),
    ).toBe(false);
  });
});
