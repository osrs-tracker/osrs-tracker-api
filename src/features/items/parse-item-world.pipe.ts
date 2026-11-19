import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';
import { singleQueryValue } from '../../common/pipes/single-query-value';

const ITEM_WORLDS = ['main', 'hardcore'] as const;
/** Which game's lookups: `hardcore` is Hardcore Worlds, which has its own Grand Exchange. */
export type ItemWorld = (typeof ITEM_WORLDS)[number];

/** Parses the optional `world` query param of an item lookup and of `GET /items?sort=lookedUp`: `main` when absent. */
@Injectable()
export class ParseItemWorldPipe implements PipeTransform<unknown, ItemWorld> {
  transform(value: unknown): ItemWorld {
    const world = singleQueryValue('world', value) ?? 'main';

    if (!ITEM_WORLDS.includes(world as ItemWorld)) {
      throw new BadRequestException(`World must be one of ${ITEM_WORLDS.join(', ')}.`);
    }

    return world as ItemWorld;
  }
}
