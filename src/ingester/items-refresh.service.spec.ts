import { Db } from 'mongodb';
import { Agent, fetch } from 'undici';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_REMOVED_ITEMS } from './ingester.config';
import { ItemsRefreshService } from './items-refresh.service';
import { JobRunsService } from './job-runs.service';

vi.mock('undici', async (importOriginal) => ({ ...(await importOriginal<typeof import('undici')>()), fetch: vi.fn() }));

const mockFetch = vi.mocked(fetch);

const ITEMS = [
  { id: 4151, name: 'Abyssal whip' },
  { id: 11802, name: 'Armadyl godsword' },
];

const NOW = new Date('2026-10-25T12:00:00Z');

/** The upsert the refresh writes for `item`: `addedAt` only when it inserts, `updatedAt` on every write. */
const upsert = (item: object) => ({
  updateOne: {
    filter: { id: (item as { id: number }).id },
    hint: { id: 1 },
    update: { $set: { ...item, updatedAt: NOW }, $setOnInsert: { addedAt: NOW } },
    upsert: true,
  },
});

/** `count` stored items the Wiki's list doesn't have. */
const unlisted = (count: number) => Array.from({ length: count }, (_, i) => ({ id: i + 1, name: `Gone ${i}` }));

/** A service on a fake `items` that holds `stored`, as `find` returns it (without `_id` and `lastFetch`). */
function setup(stored: object[]) {
  const items = {
    find: vi.fn(() => ({ toArray: async () => stored })),
    bulkWrite: vi.fn(async () => ({ matchedCount: 1, upsertedCount: 1 })),
    deleteMany: vi.fn(async () => ({ deletedCount: 3 })),
  };
  const db = { collection: () => items } as unknown as Db;
  const service = new ItemsRefreshService(db, {} as Agent, {} as JobRunsService);
  return { refresh: () => service.refresh(new AbortController().signal), items };
}

describe('ItemsRefreshService', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockImplementation(async () => Response.json(ITEMS) as never);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('upserts the new items by id with addedAt and updatedAt, then deletes the ones missing from the list', async () => {
    const { refresh, items } = setup(unlisted(3));
    await refresh();

    expect(items.bulkWrite).toHaveBeenCalledWith(ITEMS.map(upsert));
    expect(items.deleteMany).toHaveBeenCalledWith({ id: { $nin: [4151, 11802] } }, { hint: { id: 1 } });
    expect(items.bulkWrite).toHaveBeenCalledBefore(items.deleteMany);
    expect(items.find).toHaveBeenCalledWith({}, { projection: { _id: 0, lastFetch: 0 } });
  });

  it('writes nothing when every item matches its stored copy', async () => {
    // a field the Wiki omits keeps its stored value, and the stored dates aren't Wiki fields, so neither is compared
    const dates = { addedAt: new Date('2026-01-01'), updatedAt: new Date('2026-02-01') };
    const { refresh, items } = setup(ITEMS.map((item) => ({ ...item, limit: 70, ...dates })));
    await refresh();

    expect(items.bulkWrite).not.toHaveBeenCalled();
    expect(items.deleteMany).not.toHaveBeenCalled();
  });

  it('upserts only the items with a changed field, with a new updatedAt', async () => {
    const { refresh, items } = setup([ITEMS[0], { ...ITEMS[1], name: 'Armadyl Godsword', updatedAt: new Date(0) }]);
    await refresh();

    expect(items.bulkWrite).toHaveBeenCalledWith([upsert(ITEMS[1])]);
  });

  it(`skips the delete when more than ${MAX_REMOVED_ITEMS} items would go`, async () => {
    const { refresh, items } = setup(unlisted(MAX_REMOVED_ITEMS + 1));
    await refresh();

    expect(items.bulkWrite).toHaveBeenCalledOnce();
    expect(items.deleteMany).not.toHaveBeenCalled();
  });

  it('writes nothing when the list fails or is empty', async () => {
    const { refresh, items } = setup([]);
    mockFetch.mockResolvedValueOnce(new Response('', { status: 503 }) as never);
    await expect(refresh()).rejects.toThrow('HTTP 503');
    mockFetch.mockResolvedValueOnce(Response.json([]) as never);
    await expect(refresh()).rejects.toThrow('no items');

    expect(items.bulkWrite).not.toHaveBeenCalled();
    expect(items.deleteMany).not.toHaveBeenCalled();
  });
});
