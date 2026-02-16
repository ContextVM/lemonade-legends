/**
 * Lemonade Legends Badge Server
 *
 * An educational CVM server demonstrating CEP-8 payments with NIP-58 badges.
 * Price: 21 sats on day 0, increases by 21 sats each day.
 */

import { Database } from "bun:sqlite";
import {
  NostrServerTransport,
  PrivateKeySigner,
  ApplesauceRelayPool,
} from "@contextvm/sdk";
import {
  LnBolt11ZapPaymentProcessor,
  withServerPayments,
  type PricedCapability,
  type ResolvePriceFn,
} from "@contextvm/sdk/payments";
import { createLogger } from "@contextvm/sdk/core/utils/logger";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { kinds, type UnsignedEvent } from "nostr-tools";
import z from "zod/v4";

// =============================================================================
// Badge Configuration
// =============================================================================

const BADGE_NAME = "lemonade-legends";
const BADGE_DISPLAY_NAME = "Lemonade Legends";
const BADGE_DESCRIPTION = "Awarded to legends of the digital lemonade stand";
const BADGE_IMAGE =
  "https://image.nostr.build/3c3575191bdfd060e27719302abc8c7e86e29652b6e432b40988aa0c902e2dd9.png";

// =============================================================================
// Pricing Configuration
// =============================================================================

const OPENING_PRICE = 21;
const DAILY_INCREMENT = 21;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const OPENING_TIMESTAMP = Date.now();
const OPENING_DATE = new Date().toISOString().split("T")[0];

/** Returns number of days since server started. */
function getDaysElapsed(): number {
  return Math.floor((Date.now() - OPENING_TIMESTAMP) / MS_PER_DAY);
}

/** Returns current price: OPENING_PRICE + (daysElapsed × DAILY_INCREMENT) */
function getCurrentPrice(): number {
  return OPENING_PRICE + getDaysElapsed() * DAILY_INCREMENT;
}

/** Returns pricing info for display. */
function getPricingInfo() {
  return {
    currentPrice: getCurrentPrice(),
    daysElapsed: getDaysElapsed(),
    openingDate: OPENING_DATE,
    openingPrice: OPENING_PRICE,
    dailyIncrement: DAILY_INCREMENT,
  };
}

// =============================================================================
// Server Configuration
// =============================================================================

const IS_DEV = process.env.IS_DEV === "true";

const SERVER_RELAYS =
  process.env.SERVER_RELAYS?.split(",") ||
  (IS_DEV
    ? ["ws://localhost:10547"]
    : ["wss://relay.contextvm.org", "wss://cvm.otherstuff.ai"]);

const PUBLISH_RELAYS =
  process.env.PUBLISH_RELAYS?.split(",") ||
  (IS_DEV
    ? ["ws://localhost:10547"]
    : [
        "wss://relay.damus.io",
        "wss://nos.lol",
        "wss://relay.nostr.net",
        "wss://relay.primal.net",
        "wss://nostr.mom",
      ]);

const SERVER_PRIVATE_KEY =
  process.env.SERVER_PRIVATE_KEY ||
  "0000000000000000000000000000000000000000000000000000000000000001";

const LN_ADDRESS = process.env.LN_ADDRESS;
if (!LN_ADDRESS) {
  throw new Error(
    "LN_ADDRESS environment variable is required. Set your Lightning Address (e.g., user@walletofsatoshi.com)",
  );
}

// =============================================================================
// Database Setup
// =============================================================================

const db = new Database("lemonade-legends.db", { create: true });

db.run(`
  CREATE TABLE IF NOT EXISTS badge_awards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    recipient_pubkey TEXT NOT NULL,
    award_event_id TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
  );
  
  CREATE INDEX IF NOT EXISTS idx_recipient_pubkey ON badge_awards(recipient_pubkey);
`);

const insertAward = db.prepare(
  "INSERT INTO badge_awards (recipient_pubkey, award_event_id, created_at) VALUES (?, ?, ?)",
);

const getAllAwards = db.prepare(
  "SELECT id, recipient_pubkey, award_event_id, created_at FROM badge_awards ORDER BY created_at DESC",
);

const hasExistingAward = db.prepare(
  "SELECT 1 FROM badge_awards WHERE recipient_pubkey = ? LIMIT 1",
);

// =============================================================================
// Server Initialization
// =============================================================================

const logger = createLogger("lemonade-legends");
const signer = new PrivateKeySigner(SERVER_PRIVATE_KEY);
const relayPool = new ApplesauceRelayPool(PUBLISH_RELAYS);
const serverPubkey = await signer.getPublicKey();

const server = new McpServer({
  name: "lemonade-legends",
  version: "1.0.0",
});

// =============================================================================
// Payment Configuration
// =============================================================================

const pricedCapabilities: PricedCapability[] = [
  {
    method: "tools/call",
    name: "mint_badge",
    amount: OPENING_PRICE,
    maxAmount: OPENING_PRICE + 365 * DAILY_INCREMENT,
    currencyUnit: "sats",
    description: `Mint a "${BADGE_NAME}" badge. Price starts at ${OPENING_PRICE} sats and increases by ${DAILY_INCREMENT} sats each day!`,
  },
];

const resolvePrice: ResolvePriceFn = async ({ clientPubkey }) => {
  const currentPrice = getCurrentPrice();
  const pricingInfo = getPricingInfo();

  if (hasExistingAward.get(clientPubkey)) {
    return {
      rejected: true,
      amount: currentPrice,
      reason: "You already have the badge!",
    };
  }

  return {
    amount: currentPrice,
    description: `Day ${pricingInfo.daysElapsed} price: ${currentPrice} sats`,
    _meta: {
      daysElapsed: pricingInfo.daysElapsed,
      openingDate: pricingInfo.openingDate,
    },
  };
};

const paymentProcessor = new LnBolt11ZapPaymentProcessor({
  lnAddress: LN_ADDRESS,
});

// =============================================================================
// Badge Event Helpers
// =============================================================================

function createBadgeDefinitionEvent(): UnsignedEvent {
  return {
    kind: kinds.BadgeDefinition,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["d", BADGE_NAME],
      ["name", BADGE_DISPLAY_NAME],
      ["description", BADGE_DESCRIPTION],
      ["image", BADGE_IMAGE, "1024x1024"],
      ["thumb", BADGE_IMAGE, "256x256"],
    ],
    content: "",
    pubkey: serverPubkey,
  };
}

function createBadgeAwardEvent(recipientPubkey: string): UnsignedEvent {
  return {
    kind: kinds.BadgeAward,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["a", `30009:${serverPubkey}:${BADGE_NAME}`],
      ["p", recipientPubkey],
    ],
    content: `Awarded ${BADGE_NAME} badge to ${recipientPubkey}`,
    pubkey: serverPubkey,
  };
}

async function signAndPublishEvent(event: UnsignedEvent): Promise<string> {
  const signedEvent = await signer.signEvent(event);
  await relayPool.publish(signedEvent);
  return signedEvent.id;
}

// =============================================================================
// Tools
// =============================================================================

server.registerTool(
  "mint_badge",
  {
    description: `Mint a "${BADGE_NAME}" badge for your Nostr profile. Price: ${getCurrentPrice()} sats (increases by ${DAILY_INCREMENT} sats daily).`,
  },
  async ({ _meta }) => {
    const clientPubkey = _meta?.clientPubkey as string;

    if (!clientPubkey) {
      return {
        content: [
          { type: "text", text: "Error: Unable to determine your public key." },
        ],
        isError: true,
      };
    }

    // Publish badge definition first
    const badgeDef = createBadgeDefinitionEvent();
    const badgeEvent = await signAndPublishEvent(badgeDef);
    logger.info("Badge definition published", { badgeId: badgeEvent });

    // Create and publish award
    const awardEvent = createBadgeAwardEvent(clientPubkey);
    const awardEventId = await signAndPublishEvent(awardEvent);

    // Store in database
    insertAward.run(clientPubkey, awardEventId, Math.floor(Date.now() / 1000));
    logger.info("Badge awarded", { recipient: clientPubkey, awardEventId });

    return {
      content: [
        {
          type: "text",
          text: `🎉 You've been awarded the "${BADGE_NAME}" badge!\n\nAward Event ID: ${awardEventId}\n\nView your badge at: https://badges.page or https://nostrsigil.com`,
        },
      ],
    };
  },
);

server.registerTool(
  "stats",
  {
    description: "Get statistics about issued badges and current pricing",
    inputSchema: {},
    outputSchema: {
      pubkeys: z.array(z.string()),
    },
  },
  async () => {
    const awards = getAllAwards.all() as Array<{
      recipient_pubkey: string;
      award_event_id: string;
      created_at: number;
    }>;

    const pricingInfo = getPricingInfo();
    const pubkeys = Array.from(new Set(awards.map((a) => a.recipient_pubkey)));

    let text = `📊 Lemonade Legends Statistics

🍋 PRICING:
• Current: ${pricingInfo.currentPrice} sats
• Opening: ${pricingInfo.openingDate}
• Day: ${pricingInfo.daysElapsed}
• Rate: +${pricingInfo.dailyIncrement} sats/day

📈 STATS:
• Total: ${awards.length}

🏆 Recent:`;

    if (awards.length > 0) {
      awards.slice(0, 10).forEach((a, i) => {
        const date = new Date(a.created_at * 1000).toISOString().split("T")[0];
        text += `\n${i + 1}. ${a.recipient_pubkey.slice(0, 16)}... (${date})`;
      });
      if (awards.length > 10) text += `\n... and ${awards.length - 10} more`;
    } else {
      text += "\nNo badges issued yet.";
    }

    return {
      content: [{ type: "text", text }],
      structuredContent: { pubkeys },
    };
  },
);

// =============================================================================
// Transport & Startup
// =============================================================================

const baseTransport = new NostrServerTransport({
  signer,
  relayHandler: SERVER_RELAYS,
  serverInfo: {
    name: "Lemonade Legends Badge Server",
    website: "https://lemonade.contextvm.org",
  },
  injectClientPubkey: true,
});

const paidTransport = withServerPayments(baseTransport, {
  processors: [paymentProcessor],
  pricedCapabilities,
  resolvePrice,
});

async function main() {
  try {
    await relayPool.connect();
    await server.connect(paidTransport);

    // Publish badge definition on startup
    const badgeDef = createBadgeDefinitionEvent();
    const signed = await signer.signEvent(badgeDef);
    await relayPool.publish(signed);
    logger.info("Server started", {
      badgeDefId: signed.id,
      lnAddress: LN_ADDRESS,
    });
  } catch (error) {
    logger.error("Startup failed", { error: String(error) });
    process.exit(1);
  }
}

process.on("SIGINT", async () => {
  logger.info("Shutting down...");
  await relayPool.disconnect();
  db.close();
  process.exit(0);
});

main();
