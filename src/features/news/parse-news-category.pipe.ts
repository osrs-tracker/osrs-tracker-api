import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';

/** Longer than any category Jagex uses (the longest is `Behind the Scenes`). */
const MAX_CATEGORY_LENGTH = 64;

/**
 * Parses the optional `category` of `/news/archive`: one name, as `/news/categories` lists it. An unknown name isn't
 * rejected, it matches no posts; a repeated param (an array) or an empty or overlong one is a 400.
 */
@Injectable()
export class ParseNewsCategoryPipe implements PipeTransform<unknown, string | undefined> {
  transform(value: unknown): string | undefined {
    if (value === undefined) return undefined;

    if (typeof value !== 'string' || !value || value.length > MAX_CATEGORY_LENGTH) {
      throw new BadRequestException(
        `Category must be a single category name of at most ${MAX_CATEGORY_LENGTH} characters.`,
      );
    }

    return value;
  }
}
