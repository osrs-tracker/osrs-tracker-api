/** A world in a test world list: `members` sets the flag `parseWorldList` counts as members. */
export interface FixtureWorld {
  players: number;
  members?: boolean;
  location?: number;
}

/**
 * Jagex's world list format, for specs (`parseWorldList` in `@osrs-tracker/hiscores` reads it): the payload size, the
 * world count, then per world its ID, flags, address, activity, location and players.
 */
export function encodeWorldList(worlds: FixtureWorld[]): Uint8Array<ArrayBuffer> {
  const parts = worlds.map(({ players, members = false, location = 0 }, i) => {
    const address = Buffer.from(`oldschool${i + 1}.runescape.com\0-\0`);
    const world = Buffer.alloc(6 + address.length + 3);
    world.writeUInt16BE(301 + i, 0);
    world.writeInt32BE(members ? 1 : 0, 2);
    address.copy(world, 6);
    world.writeUInt8(location, 6 + address.length);
    world.writeInt16BE(players, 7 + address.length);
    return world;
  });
  const header = Buffer.alloc(6);
  const payload = 2 + parts.reduce((size, part) => size + part.length, 0);
  header.writeInt32BE(payload, 0);
  header.writeUInt16BE(worlds.length, 4);
  return new Uint8Array(Buffer.concat([header, ...parts]));
}
