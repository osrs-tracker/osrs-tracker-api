import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';
import { decodeNewsCursor, NewsArchiveCursor } from './news-archive';

/** Longer than any cursor `encodeNewsCursor` makes for a real post, so a huge value isn't decoded. */
const MAX_CURSOR_LENGTH = 1024;

/** Parses the optional `before` of `/news/archive`: a `next` cursor from an earlier page. */
@Injectable()
export class ParseNewsCursorPipe implements PipeTransform<unknown, NewsArchiveCursor | undefined> {
  transform(value: unknown): NewsArchiveCursor | undefined {
    if (value === undefined) return undefined;

    const cursor = typeof value === 'string' && value.length <= MAX_CURSOR_LENGTH ? decodeNewsCursor(value) : undefined;
    if (!cursor) throw new BadRequestException('Before must be a next cursor from an earlier page.');

    return cursor;
  }
}
