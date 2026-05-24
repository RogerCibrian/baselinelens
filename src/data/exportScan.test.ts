import { describe, expect, it } from "vitest";

import { baseline, rec, result, scan, userState } from "../test/fixtures";
import { buildCsv, buildJson } from "./exportScan";

const HEADER =
  "ID,Category,Title,Level,Assessment,Status,Raw status,Expected,Found,Error," +
  "Exception reason,Exception granted by,Exception granted at," +
  "Attestation outcome,Attested by,Attested at,Note,Last scanned";

describe("buildCsv", () => {
  it("emits the header row and one CRLF-terminated row per rec", () => {
    const bl = baseline([rec("1.1", "L1", "1")]);
    const sc = scan({ "1.1": result("Pass") });
    const lines = buildCsv(bl, sc, userState()).split("\r\n");
    expect(lines[0]).toBe(HEADER);
    expect(lines[1].startsWith("1.1,")).toBe(true);
    expect(lines[2]).toBe(""); // trailing CRLF
  });

  it("quotes fields with commas and doubles embedded quotes (RFC 4180)", () => {
    const bl = baseline([rec("1.1", "L1", "1", { title: 'He said "hi", ok' })]);
    const sc = scan({ "1.1": result("Pass") });
    expect(buildCsv(bl, sc, userState())).toContain('"He said ""hi"", ok"');
  });

  it("neutralizes leading formula characters so spreadsheets can't execute them", () => {
    const bl = baseline([rec("1.1", "L1", "1")]);
    const sc = scan({ "1.1": result("Pass") });
    const us = userState({
      notes: { "1.1": { text: "=HYPERLINK(0)", updatedAt: "2025-05-15T12:00:00.000Z" } },
    });
    expect(buildCsv(bl, sc, us)).toContain("'=HYPERLINK(0)");
  });

  it("shows the effective status while keeping the raw verdict visible", () => {
    const bl = baseline([rec("1.1", "L1", "1")]);
    const sc = scan({ "1.1": result("Fail") });
    const us = userState({
      exceptions: {
        "1.1": { reason: "accepted", grantedAt: "2025-05-15T12:00:00.000Z", grantedBy: null },
      },
    });
    const row = buildCsv(bl, sc, us).split("\r\n")[1].split(",");
    expect(row[5]).toBe("Accepted exception"); // Status column
    expect(row[6]).toBe("Fail"); // Raw status column
  });
});

describe("buildJson", () => {
  it("wraps the rows with benchmark/source context", () => {
    const bl = baseline([rec("1.1", "L1", "1")]);
    const sc = scan({ "1.1": result("Pass") });
    const doc = JSON.parse(buildJson(bl, sc, userState()));
    expect(doc.benchmark).toBe("Bench v1");
    expect(doc.source).toBe("bench.pdf");
    expect(doc.results).toHaveLength(1);
    expect(doc.results[0].id).toBe("1.1");
  });

  it("keeps formula-leading values verbatim (JSON consumers don't evaluate them)", () => {
    const bl = baseline([rec("1.1", "L1", "1")]);
    const sc = scan({ "1.1": result("Pass") });
    const us = userState({
      notes: { "1.1": { text: "=HYPERLINK(0)", updatedAt: "2025-05-15T12:00:00.000Z" } },
    });
    const doc = JSON.parse(buildJson(bl, sc, us));
    expect(doc.results[0].note).toBe("=HYPERLINK(0)");
  });
});
