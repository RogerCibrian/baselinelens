import { paragraphs } from "../../data/consoleModel";

/**
 * Renders one text section of the drawer body — a heading and one
 * `<p>` per paragraph parsed out of `text`.
 */
export function DrawerText({ title, text }: { title: string; text: string }) {
  return (
    <section className="drawer-section">
      <h4>{title}</h4>
      {paragraphs(text).map((para, i) => (
        // Paragraphs are a pure function of immutable `text` — they
        // can't reorder or get inserted — but pair the index with the
        // content so duplicate paragraphs still get distinct keys.
        <p key={`${i}:${para}`} className="drawer-text">
          {para}
        </p>
      ))}
    </section>
  );
}
