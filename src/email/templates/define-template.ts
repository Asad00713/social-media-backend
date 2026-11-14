import type { EmailTemplateDef } from './types';

/** Identity helper so a template's props type is inferred from its def. */
export function defineTemplate<P>(
  def: EmailTemplateDef<P>,
): EmailTemplateDef<P> {
  return def;
}
