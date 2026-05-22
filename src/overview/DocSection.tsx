import type { ReactNode } from "react";

/** Numbered report section with a "§ N" heading. */
export function DocSection({
  num,
  title,
  children,
}: {
  num: number;
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="doc-section">
      <h2 className="doc-section-heading serif">
        <span className="doc-section-num mono">§ {num}</span>
        {title}
      </h2>
      {children}
    </section>
  );
}
