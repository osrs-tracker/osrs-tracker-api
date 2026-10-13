import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';
import { PLAYER_COUNT_RANGES, PlayerCountRange } from './player-count-history';

/** Parses the `range` query param of the player count history: one of `PLAYER_COUNT_RANGES`, `24h` when absent. */
@Injectable()
export class ParsePlayerCountRangePipe implements PipeTransform<string | undefined, PlayerCountRange> {
  transform(value: string | undefined): PlayerCountRange {
    if (value === undefined) return '24h';
    if (!(PLAYER_COUNT_RANGES as readonly string[]).includes(value)) {
      throw new BadRequestException(`Invalid range "${value}": use ${PLAYER_COUNT_RANGES.join(', ')}.`);
    }

    return value as PlayerCountRange;
  }
}
