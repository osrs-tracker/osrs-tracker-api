import { Db } from 'mongodb';
import { Agent, fetch } from 'undici';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_REMOVED_ITEMS } from './ingester.config';
import { ItemsRefreshService } from './items-refresh.service';
import { JobRunsService } from './job-runs.service';

vi.mock('undici', async (importOriginal) => ({ ...(await importOriginal<typeof import('undici')>()), fetch: vi.fn() }));

const mockFetch = vi.mocked(fetch);

const ITEMS = [
  { id: 4151, name: 'Abyssal whip' },
  { id: 11802, name: 'Armadyl godsword' },
];

/** A service on a fake `items` where `removable` stored items are missing from the Wiki's list. */
function setup(removable: number) {
  const items = {
    bulkWrite: vi.fn(async () => ({ matchedCount: 1, upsertedCount: 1 })),
    countDocuments: vi.fn(async () => removable),
    deleteMany: vi.fn(async () => ({ deletedCount: removable })),
  };
  const db = { collection: () => items } as unknown as Db;
  const service = new ItemsRefreshService(db, {} as Agent, {} as JobRunsService);
  return { refresh: () => service.refresh(new AbortController().signal), items };
}

describe('ItemsRefreshService', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockImplementation(async () => Response.json(ITEMS) as never);
  });

  it('upserts every item by id, then deletes the ones missing from the list', async () => {
    const { refresh, items } = setup(3);
    await refresh();

    expect(items.bulkWrite).toHaveBeenCalledWith(
      ITEMS.map((item) => ({
        updateOne: { filter: { id: item.id }, hint: { id: 1 }, update: { $set: item }, upsert: true },
      })),
    );
    expect(items.deleteMany).toHaveBeenCalledWith({ id: { $nin: [4151, 11802] } }, { hint: { id: 1 } });
    expect(items.bulkWrite).toHaveBeenCalledBefore(items.deleteMany);
  });

  it(`skips the delete when more than ${MAX_REMOVED_ITEMS} items would go`, async () => {
    const { refresh, items } = setup(MAX_REMOVED_ITEMS + 1);
    await refresh();

    expect(items.bulkWrite).toHaveBeenCalledOnce();
    expect(items.deleteMany).not.toHaveBeenCalled();
  });

  it('writes nothing when the list fails or is empty', async () => {
    const { refresh, items } = setup(0);
    mockFetch.mockResolvedValueOnce(new Response('', { status: 503 }) as never);
    await expect(refresh()).rejects.toThrow('HTTP 503');
    mockFetch.mockResolvedValueOnce(Response.json([]) as never);
    await expect(refresh()).rejects.toThrow('no items');

    expect(items.bulkWrite).not.toHaveBeenCalled();
    expect(items.deleteMany).not.toHaveBeenCalled();
  });
});
