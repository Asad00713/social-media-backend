/** A subject is one header line: CR/LF would let text inject headers. */
export function toSubjectLine(subject: string): string {
  return subject.replace(/\s*[\r\n]+\s*/g, ' ').trim();
}
