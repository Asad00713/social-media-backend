import { Fragment } from 'react';

/** At most `max` characters (counted as code points), ending in '…' when cut. */
export function clipMessage(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  return `${chars
    .slice(0, max - 1)
    .join('')
    .trimEnd()}…`;
}

/**
 * A sender's message with its line breaks kept. Every line is a React text
 * node, so markup in the message is escaped, never interpreted.
 */
export function MessageText({ text }: { text: string }) {
  return (
    <>
      {text.split(/\r\n|\r|\n/).map((line, i) => (
        <Fragment key={i}>
          {i > 0 ? <br /> : null}
          {line}
        </Fragment>
      ))}
    </>
  );
}
