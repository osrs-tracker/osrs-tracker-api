import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';
import { PlayerUtils } from './player.utils';

/**
 * Normalizes a username route param and rejects anything that isn't a valid OSRS display name.
 * Express has already decoded the param once, so a leftover `%` means it was double-encoded and is rejected too.
 */
@Injectable()
export class ParseUsernamePipe implements PipeTransform<string, string> {
  transform(value: string): string {
    const username = PlayerUtils.normalizeUsername(value ?? '');

    if (!username) throw new BadRequestException('No username provided');
    if (!PlayerUtils.isValidUsername(username)) {
      throw new BadRequestException(
        'Usernames must be 1 to 12 characters long and only contain letters, numbers, spaces, hyphens and underscores.',
      );
    }

    return username;
  }
}
