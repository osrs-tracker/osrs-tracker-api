import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';

const MAX_QUERY_LENGTH = 64;

/** Parses the `query` route param of item search: present, and at most 64 characters. */
@Injectable()
export class ParseItemSearchQueryPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (!value) throw new BadRequestException('No search query provided');
    if (value.length > MAX_QUERY_LENGTH) {
      throw new BadRequestException(`Search query must be ${MAX_QUERY_LENGTH} characters or less`);
    }

    return value;
  }
}
