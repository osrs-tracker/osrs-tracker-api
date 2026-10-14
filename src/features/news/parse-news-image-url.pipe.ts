import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';

/** Jagex's CDN, where the feed's images live: the only origin `/news/image` fetches from. */
const OSRS_CDN_ORIGIN = 'https://cdn.runescape.com';
const MAX_URL_LENGTH = 512;

/**
 * Parses the `url` of `/news/image`: a plain `https://cdn.runescape.com/` URL of at most 512 characters, without
 * credentials, query or hash, returned as `URL.href`. Comparing the parsed origin, not a prefix, is what keeps the
 * route from fetching and converting another host's images (`https://cdn.runescape.com.evil.example/`).
 */
@Injectable()
export class ParseNewsImageUrlPipe implements PipeTransform<string | undefined, string> {
  transform(value: string | undefined): string {
    if (!value) throw new BadRequestException('No URL provided');
    if (value.length > MAX_URL_LENGTH) {
      throw new BadRequestException(`URL must be ${MAX_URL_LENGTH} characters or less`);
    }

    const url = URL.parse(value);
    if (url?.origin !== OSRS_CDN_ORIGIN || url.username || url.password) {
      throw new BadRequestException(`URL must start with "${OSRS_CDN_ORIGIN}/"`);
    }
    // Only plain CDN paths: a query string or hash would let every request create a new image cache entry.
    if (url.search || url.hash) throw new BadRequestException('URL must not contain a query or hash');

    return url.href;
  }
}
