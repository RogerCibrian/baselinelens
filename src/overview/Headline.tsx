import type { Headline } from "./util";

/** The report's one-line verdict above the score cards. Reads the
 * trend direction, or a snapshot/first-scan/incomplete framing when
 * there's no comparison to draw. */
export function HeadlineH1({
  headline,
  errorsSevere,
}: {
  headline: Headline;
  errorsSevere: boolean;
}) {
  if (headline.kind === "trend" && errorsSevere) {
    return (
      <h1 className="serif overview-headline">Compliance read is incomplete.</h1>
    );
  }
  if (headline.kind === "empty") {
    // No summaries (trend history was reset) but a scan still exists —
    // a "snapshot" framing reads as a report headline; the bare
    // benchmark name did not.
    return <h1 className="serif overview-headline">Compliance snapshot.</h1>;
  }
  if (headline.kind === "first") {
    return <h1 className="serif overview-headline">First scan recorded.</h1>;
  }
  return (
    <h1 className="serif overview-headline">
      Compliance is{" "}
      <em className={`headline-trend headline-trend-${headline.trend}`}>
        {headline.trend}
      </em>
      .
    </h1>
  );
}

/** The supporting fact line under the headline: points-delta over the
 * window, remediated/regressed counts, and weak-category count. */
export function HeadlineFacts({
  headline,
  errorsSevere,
}: {
  headline: Headline;
  errorsSevere: boolean;
}) {
  if (headline.kind === "empty") {
    return (
      <p className="headline-facts headline-facts-first">
        Trend resumes after the next scan.
      </p>
    );
  }
  if (headline.kind === "first") {
    return (
      <p className="headline-facts headline-facts-first">
        Trend metrics appear after the next scan.
      </p>
    );
  }
  if (errorsSevere) {
    return (
      <p className="headline-facts headline-facts-first">
        Trend paused — most controls could not be evaluated.
      </p>
    );
  }
  const { pointsDelta, windowDays, improved, regressed, weakCategoryCount } =
    headline;
  const arrow = pointsDelta >= 0 ? "↑" : "↓";
  return (
    <p className="headline-facts">
      <span className="headline-fact mono">
        {arrow} {Math.abs(pointsDelta).toFixed(1)} pts in {windowDays} day
        {windowDays === 1 ? "" : "s"}
      </span>
      <span className="headline-divider" aria-hidden="true" />
      <span className="headline-fact mono">
        {improved} remediated · {regressed} regressed
      </span>
      {weakCategoryCount > 0 && (
        <>
          <span className="headline-divider" aria-hidden="true" />
          <span className="headline-fact mono">
            {weakCategoryCount} categor
            {weakCategoryCount === 1 ? "y" : "ies"} below 50%
          </span>
        </>
      )}
    </p>
  );
}
