import { ValidateIf } from 'class-validator';

/**
 * Like `@IsOptional()`, but only skips validation when the property is absent (`undefined`).
 * An explicit `null` is still validated (and rejected by the type validators), so it can't
 * reach Prisma for a non-nullable column. Use `@IsOptional()` for columns where `null` clears.
 */
export function IsOptionalNonNull(): PropertyDecorator {
  return ValidateIf((_object, value) => value !== undefined);
}
