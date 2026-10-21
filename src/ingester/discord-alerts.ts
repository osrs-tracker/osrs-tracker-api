import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Agent, fetch } from 'undici';
import { AGENT, USER_AGENT } from '../common/agent/agent.provider';
import { IngesterEnv } from '../config/env';

/** @see https://discord.com/developers/docs/resources/message#embed-object-embed-limits */
const DISCORD_DESCRIPTION_MAX_LENGTH = 4096;

const TIMEOUT_MS = 5_000;

/**
 * Alerts to the osrs-tracker Discord webhook (`WEBHOOK_URL`), which the scraping Lambdas alerted to before their writes
 * moved here. Like their `discordAlert` (osrs-tracker-aws `lambda/shared`), without the links to CloudWatch.
 */
@Injectable()
export class DiscordAlerts {
  private readonly logger = new Logger(DiscordAlerts.name);
  private readonly webhookUrl: string;

  constructor(
    config: ConfigService<IngesterEnv, true>,
    @Inject(AGENT) private readonly agent: Agent,
  ) {
    this.webhookUrl = config.get('WEBHOOK_URL', { infer: true });
  }

  /**
   * Sends a red embed listing `names`. Never rejects: a failed alert is logged, never with the URL, which holds the
   * webhook's token. A description over Discord's limit is truncated (it would reject the alert).
   */
  async send(title: string, summary: string, names: string[]): Promise<void> {
    let description = `${summary} ${names.length} player${names.length > 1 ? 's' : ''}:\n`;
    description += names.map((name) => `- ${name}`).join('\n');
    if (description.length > DISCORD_DESCRIPTION_MAX_LENGTH)
      description = `${description.slice(0, DISCORD_DESCRIPTION_MAX_LENGTH - 1)}…`;

    try {
      const response = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': USER_AGENT },
        body: JSON.stringify({
          embeds: [
            {
              title,
              description,
              author: { name: 'osrs-tracker-ingester' },
              color: 0xff0000,
              timestamp: new Date().toISOString(),
            },
          ],
        }),
        dispatcher: this.agent,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      // fetch resolves on 4xx/5xx too (e.g. a revoked webhook)
      if (!response.ok) this.logger.error(`Discord alert "${title}" not sent: HTTP ${response.status}`);
    } catch (error) {
      this.logger.error(`Discord alert "${title}" not sent: ${error}`);
    }
  }
}
