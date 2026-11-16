import { Fragment } from 'react';

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
