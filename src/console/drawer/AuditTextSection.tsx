import { auditLines } from "../../data/consoleModel";

/**
 * Collapsible drawer section showing the benchmark's raw audit-procedure
 * text — the source the classifier read, available to cross-check the
 * verdict against what the benchmark states. Collapsed by default; the
 * PDF's hard line wraps are reflowed for display while the stored text
 * stays verbatim.
 */
export function AuditTextSection({ text }: { text: string }) {
  return (
    <details className="drawer-section drawer-audit">
      <summary>Audit procedure</summary>
      {auditLines(text).map((line, i) => (
        // Lines are a pure function of immutable `text`; pair the index
        // with the content so repeated lines get distinct keys.
        <p key={`${i}:${line}`} className="drawer-text">
          {line}
        </p>
      ))}
    </details>
  );
}
