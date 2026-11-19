import { PayloadTooLargeException } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { jsonShape, MAX_JSON_DEPTH, MAX_JSON_NODES } from './bounded-json';

/**
 * Refuses a parsed body that is nested too deeply or holds too many nodes,
 * BEFORE anything walks it recursively.
 *
 * This has to be middleware rather than a validator, which is not where it
 * was first put. `class-transformer`'s `plainToInstance` recurses over the
 * whole plain object to build the DTO, and the global `ValidationPipe` runs
 * it BEFORE any `@Validate` constraint gets a turn - so a
 * `@Validate(BoundedJsonConstraint)` on the field never fired. Measured: a
 * 5,000-deep `metadata` threw
 *
 *   RangeError: Maximum call stack size exceeded
 *     at TransformOperationExecutor.transform (class-transformer)
 *
 * with the field-level guard in place. The DTO guard is still worth keeping
 * for the shapes that do reach it, but the stack overflow can only be stopped
 * ahead of the transform.
 *
 * A body size limit does not cover this either: the deep payload above is a
 * few hundred kilobytes of text, comfortably inside the 256kb ceiling. V8's
 * `JSON.parse` is iterative, so the body parses without complaint and the
 * crash lands later, in our own stack.
 *
 * `jsonShape` is iterative for the same reason: a recursive depth check would
 * overflow on exactly the input it exists to reject.
 */
export function bodyShapeMiddleware() {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const body: unknown = req.body;
    if (body === null || typeof body !== 'object') return next();

    const { tooDeep, tooBig, depth, nodes } = jsonShape(body);
    if (tooDeep) {
      throw new PayloadTooLargeException(
        `Request body is nested too deeply (depth ${depth}, max ${MAX_JSON_DEPTH})`,
      );
    }
    if (tooBig) {
      throw new PayloadTooLargeException(
        `Request body has too many entries (over ${nodes - 1}, max ${MAX_JSON_NODES})`,
      );
    }
    next();
  };
}
