import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';
import { BROWSE_LETTERS } from './item-browse';

/** Parses the `letter` route param of item browse: one of `BROWSE_LETTERS`, lowercase only (one URL per page). */
@Injectable()
export class ParseBrowseLetterPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (!BROWSE_LETTERS.includes(value)) {
      throw new BadRequestException(
        `Invalid letter "${value}": use a to z, or 0 for names not starting with a letter.`,
      );
    }

    return value;
  }
}
