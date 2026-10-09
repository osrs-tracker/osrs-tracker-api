import { logOutgoingRequests } from '@osrs-tracker/logger';
import { CLS_ID, ClsServiceManager } from 'nestjs-cls';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { fetch } from 'undici';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiLogger } from './logger';

describe('outgoing requests', () => {
  const lines: Record<string, unknown>[] = [];
  let server: Server;
  let url: string;
  let stop: () => void;

  beforeAll(async () => {
    server = createServer((_req, res) => res.end('ok'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hiscores`;
    stop = logOutgoingRequests({
      logger: createApiLogger({ write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>) }),
    });
  });

  afterAll(() => {
    stop();
    server.close();
  });

  it("logs undici's fetch as type outgoing, with the requestId of the request that made it", async () => {
    const cls = ClsServiceManager.getClsService();

    // The body is read after the request's context has ended: the requestId is taken when the fetch starts
    const response = await cls.run(() => {
      cls.set(CLS_ID, 'request-1');
      return fetch(url);
    });
    await response.text();

    expect(lines).toEqual([
      expect.objectContaining({ level: 'info', type: 'outgoing', status: '200', url, requestId: 'request-1' }),
    ]);
  });
});
