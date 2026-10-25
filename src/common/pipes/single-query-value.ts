import { BadRequestException } from '@nestjs/common';

/** A query param's value, or a 400 when it's repeated (Express parses `?a=1&a=2` as an array). */
export function singleQueryValue(name: string, value: unknown): string | undefined {
  if (value === undefined || typeof value === 'string') return value;

  throw new BadRequestException(`Give ${name} at most once.`);
}
