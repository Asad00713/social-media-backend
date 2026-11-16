import type { AnyTemplateDef, EmailTemplateDef } from './types';

/** Identity helper so a template's props type is inferred from its def. */
export function defineTemplate<P>(
  def: EmailTemplateDef<P>,
): EmailTemplateDef<P> {
  return def;
}

/** The preference event an email is governed by; null for mandatory mail. */
export function eventOf(def: AnyTemplateDef, props: unknown): string | null {
  return def.eventFor ? def.eventFor(props) : def.event;
}
