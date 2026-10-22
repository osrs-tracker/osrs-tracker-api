import { Db } from 'mongodb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HISCORE_LAYOUTS_COLLECTION } from '../common/mongo/collections';
import { CleanHiscoresService } from './clean-hiscores.service';
import { HAS_NO_HISCORE_ENTRIES, HAS_SCRAPING_OFFSETS } from './clean-hiscores';
import { DiscordAlerts } from './discord-alerts';
import { JobRunsService } from './job-runs.service';

const NOW = new Date('2026-10-14T00:00:30Z');
const DAY = 24 * 60 * 60 * 1000;

/** A service on fake `players` and `hiscoreLayouts`, where a player was scraped in the last 2 days when `scraped`. */
function setup(scraped = true) {
  const players = {
    aggregate: vi.fn(() => ({ toArray: async () => [{ username: 'zezima', dropped: [3] }] })),
    updateMany: vi.fn(async () => ({ modifiedCount: 1 })),
    distinct: vi.fn(async () => [1, 2]),
    deleteMany: vi.fn(async () => ({ deletedCount: 1 })),
    findOne: vi.fn(async () => (scraped ? { _id: 'id' } : null)),
  };
  const layouts = { deleteMany: vi.fn(async () => ({ deletedCount: 1 })) };
  const db = {
    collection: (name: string) => (name === HISCORE_LAYOUTS_COLLECTION ? layouts : players),
  } as unknown as Db;
  const alerts = { sendText: vi.fn(async () => undefined) };
  const service = new CleanHiscoresService(db, {} as JobRunsService, alerts as unknown as DiscordAlerts);
  return { service, players, layouts, alerts };
}

describe('CleanHiscoresService', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => vi.useRealTimers());

  it('drops offsets, pulls old entries, deletes unused layouts and empty players, in that order', async () => {
    const { service, players, layouts, alerts } = setup();
    await service.clean(new AbortController().signal);

    const [dropUpdate, pull] = players.updateMany.mock.calls as unknown[][];
    expect(dropUpdate[0]).toEqual(HAS_SCRAPING_OFFSETS);
    // 90 days before the start of the UTC day
    expect(pull).toEqual([{}, { $pull: { hiscoreEntries: { d: { $lt: new Date('2026-07-16T00:00:00Z') } } } }]);
    expect(layouts.deleteMany).toHaveBeenCalledWith({ _id: { $nin: [1, 2] }, since: { $lt: new Date(+NOW - DAY) } });
    expect(players.deleteMany).toHaveBeenCalledWith(HAS_NO_HISCORE_ENTRIES);
    expect(players.findOne).toHaveBeenCalledWith(
      { 'hiscoreEntries.d': { $gte: new Date(+NOW - 2 * DAY) } },
      { projection: { _id: 1 } },
    );

    expect(players.updateMany).toHaveBeenCalledBefore(players.distinct);
    expect(players.distinct).toHaveBeenCalledBefore(layouts.deleteMany);
    expect(layouts.deleteMany).toHaveBeenCalledBefore(players.deleteMany);
    expect(alerts.sendText).not.toHaveBeenCalled();
  });

  it('alerts, then fails the run, when nothing was scraped in 2 days', async () => {
    const { service, players, alerts } = setup(false);
    const message = 'No hiscores were scraped in the last 2 days.';
    await expect(service.clean(new AbortController().signal)).rejects.toThrow(message);

    expect(alerts.sendText).toHaveBeenCalledExactlyOnceWith('No hiscores scraped', message);
    // the clean-ups ran first
    expect(players.deleteMany).toHaveBeenCalledOnce();
  });

  it('stops before the next step once the shutdown aborts', async () => {
    const { service, players, layouts } = setup();
    const stopping = new AbortController();
    players.updateMany.mockImplementationOnce(async () => {
      stopping.abort();
      return { modifiedCount: 1 };
    });
    await expect(service.clean(stopping.signal)).rejects.toThrow();

    expect(players.updateMany).toHaveBeenCalledOnce();
    expect(layouts.deleteMany).not.toHaveBeenCalled();
  });
});
