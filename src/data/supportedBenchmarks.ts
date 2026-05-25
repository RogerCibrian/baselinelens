/** A supported-benchmark group: one target OS and the editions/versions
 * the parser has been built and tested against. Drives both the
 * onboarding "currently supported" readout and the unsupported-benchmark
 * warning, so the two never disagree. */
export type SupportedBenchmarkGroup = {
  os: string;
  editions: { name: string; versions: string[] }[];
};

export const SUPPORTED_BENCHMARKS: SupportedBenchmarkGroup[] = [
  {
    os: "Windows 11",
    editions: [
      { name: "Intune", versions: ["v4.0.0", "v3.0.1"] },
      { name: "Enterprise", versions: ["v5.0.1"] },
      { name: "Stand-alone", versions: ["v5.0.0"] },
    ],
  },
  {
    os: "Windows 10",
    editions: [
      { name: "Intune", versions: ["v4.0.0"] },
      { name: "Enterprise", versions: ["v4.0.0"] },
      { name: "Stand-alone", versions: ["v4.0.0", "v3.0.0"] },
    ],
  },
];

/** The exact title CIS prints for an (os, edition) pair. Intune sits
 * before the OS (`Intune for Windows 11`); the other editions sit after
 * it (`Windows 11 Enterprise`). */
function benchmarkTitle(os: string, edition: string): string {
  return edition === "Intune"
    ? `CIS Microsoft Intune for ${os} Benchmark`
    : `CIS Microsoft ${os} ${edition} Benchmark`;
}

/** True when a parsed benchmark name and version exactly match one the
 * parser was built and tested against. Drives a soft onboarding warning,
 * so an empty or garbled name (an anomalous PDF header) counts as
 * unsupported. */
export function isSupportedBenchmark(name: string, version: string): boolean {
  const wantName = name.replace(/\s+/g, " ").trim();
  const wantVersion = version.trim();
  if (wantName === "" || wantVersion === "") return false;
  return SUPPORTED_BENCHMARKS.some((group) =>
    group.editions.some(
      (edition) =>
        benchmarkTitle(group.os, edition.name) === wantName &&
        edition.versions.includes(wantVersion),
    ),
  );
}
