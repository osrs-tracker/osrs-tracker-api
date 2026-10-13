import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';

/** A date (`2026-10-13`, midnight UTC) or a date and time with a zone (`Z` or `±hh:mm`). */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2}))?$/;

/**
 * Parses the `date` of `/news/since/:date`: an ISO 8601 date, or a date and time with a zone (one without would be read
 * in the server's time zone). Rejects dates that don't exist (`2026-02-31`), which `Date` would roll over.
 */
@Injectable()
export class ParseSinceDatePipe implements PipeTransform<string, Date> {
  transform(value: string): Date {
    const date = new Date(value);
    // `Date` rolls a day that doesn't exist over into the next month: compare the calendar day it read
    const day = ISO_DATE.test(value ?? '') && new Date(`${value.slice(0, 10)}T00:00:00Z`);

    if (
      !day ||
      isNaN(date.getTime()) ||
      isNaN(day.getTime()) ||
      day.toISOString().slice(0, 10) !== value.slice(0, 10)
    ) {
      throw new BadRequestException('Date must be an ISO 8601 date, like 2026-10-13 or 2026-10-13T12:00:00Z.');
    }

    return date;
  }
}
