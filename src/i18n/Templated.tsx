/**
 * Renders a "{token}" template with the substituted value in its own element.
 *
 * Several marketing lines emphasise one figure inside a sentence — "+190
 * verified this quarter", "Fernway just joined". Writing the sentence around a
 * hardcoded number would put half the copy back into the component, and
 * splitting it into two dictionary keys would make the Hebrew read as two
 * fragments. This keeps the sentence whole in the dictionary while letting the
 * substituted value carry its own styling and, in Hebrew, its own LTR run.
 */
export function Templated({
  template,
  token = "count",
  value,
  className,
}: {
  template: string;
  token?: string;
  value: string;
  className?: string;
}) {
  const [before, after = ""] = template.split(`{${token}}`);
  return (
    <>
      {before}
      <span className={["ltr-token", className].filter(Boolean).join(" ")}>{value}</span>
      {after}
    </>
  );
}
