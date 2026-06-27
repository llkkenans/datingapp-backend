/**
 * One-off script: delete test users and all their dependent rows.
 *
 * Usage:
 *   DRY RUN (default — just print counts, delete nothing):
 *     npx ts-node scripts/delete-test-users.ts
 *
 *   LIVE DELETE (atomic, wrapped in a single transaction):
 *     DRY_RUN=false npx ts-node scripts/delete-test-users.ts
 */

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

const USER_IDS = [
  '2a47a865-765e-4b54-b8e3-9e9ccf39f293',
  '0c88a90a-c862-4bb9-903e-bf77c9d00abb',
];

const DRY_RUN = process.env.DRY_RUN !== 'false';

// ─── Dry-run: count rows that would be deleted ────────────────────────────────

async function dryRun() {
  console.log('=== DRY RUN — no rows will be deleted ===\n');
  console.log('Target user IDs:');
  USER_IDS.forEach((id) => console.log(`  ${id}`));
  console.log('');

  // Conversations involving either user (needed to scope Message count)
  const conversations = await prisma.conversation.findMany({
    where: { OR: [{ userAId: { in: USER_IDS } }, { userBId: { in: USER_IDS } }] },
    select: { id: true },
  });
  const conversationIds = conversations.map((c) => c.id);

  const [
    ratingCount,
    messageCount,
    conversationCount,
    matchSessionCount,
    reportCount,
    blockCount,
    likeCount,
    commentCount,
    discoverPostCount,
    userCount,
  ] = await Promise.all([
    prisma.rating.count({
      where: { OR: [{ raterId: { in: USER_IDS } }, { ratedId: { in: USER_IDS } }] },
    }),
    prisma.message.count({
      where: {
        OR: [
          { senderId: { in: USER_IDS } },
          { conversationId: { in: conversationIds } },
        ],
      },
    }),
    prisma.conversation.count({
      where: { OR: [{ userAId: { in: USER_IDS } }, { userBId: { in: USER_IDS } }] },
    }),
    prisma.matchSession.count({
      where: { OR: [{ userAId: { in: USER_IDS } }, { userBId: { in: USER_IDS } }] },
    }),
    prisma.report.count({
      where: { reporterId: { in: USER_IDS } },
    }),
    prisma.block.count({
      where: { OR: [{ blockerId: { in: USER_IDS } }, { blockedId: { in: USER_IDS } }] },
    }),
    prisma.like.count({
      where: { userId: { in: USER_IDS } },
    }),
    prisma.comment.count({
      where: { userId: { in: USER_IDS } },
    }),
    prisma.discoverPost.count({
      where: { userId: { in: USER_IDS } },
    }),
    prisma.user.count({
      where: { id: { in: USER_IDS } },
    }),
  ]);

  const rows = [
    { table: 'Rating',        count: ratingCount },
    { table: 'Message',       count: messageCount },
    { table: 'Conversation',  count: conversationCount },
    { table: 'MatchSession',  count: matchSessionCount },
    { table: 'Report',        count: reportCount },
    { table: 'Block',         count: blockCount },
    { table: 'Like',          count: likeCount },
    { table: 'Comment',       count: commentCount },
    { table: 'DiscoverPost',  count: discoverPostCount },
    { table: 'User',          count: userCount },
  ];

  console.log('Rows that would be deleted:');
  console.log('─'.repeat(36));
  rows.forEach(({ table, count }) => {
    console.log(`  ${table.padEnd(18)} ${count}`);
  });
  console.log('─'.repeat(36));
  const total = rows.reduce((sum, r) => sum + r.count, 0);
  console.log(`  ${'TOTAL'.padEnd(18)} ${total}`);

  if (userCount < USER_IDS.length) {
    console.log(
      `\n⚠  Warning: only ${userCount} of ${USER_IDS.length} target users exist in the database.`,
    );
  }

  console.log('\nTo execute the deletion, run:');
  console.log('  DRY_RUN=false npx ts-node scripts/delete-test-users.ts\n');
}

// ─── Live delete: atomic transaction ─────────────────────────────────────────

async function liveDelete() {
  console.log('=== LIVE DELETE — this is irreversible ===\n');
  console.log('Target user IDs:');
  USER_IDS.forEach((id) => console.log(`  ${id}`));
  console.log('');

  const result = await prisma.$transaction(async (tx) => {
    // Need conversation IDs upfront to scope Message deletes
    const conversations = await tx.conversation.findMany({
      where: { OR: [{ userAId: { in: USER_IDS } }, { userBId: { in: USER_IDS } }] },
      select: { id: true },
    });
    const conversationIds = conversations.map((c) => c.id);

    // 1. Rating
    const ratings = await tx.rating.deleteMany({
      where: { OR: [{ raterId: { in: USER_IDS } }, { ratedId: { in: USER_IDS } }] },
    });

    // 2. Message (sent by user, OR in any conversation they belong to)
    const messages = await tx.message.deleteMany({
      where: {
        OR: [
          { senderId: { in: USER_IDS } },
          { conversationId: { in: conversationIds } },
        ],
      },
    });

    // 3. Conversation
    const convs = await tx.conversation.deleteMany({
      where: { OR: [{ userAId: { in: USER_IDS } }, { userBId: { in: USER_IDS } }] },
    });

    // 4. MatchSession
    const sessions = await tx.matchSession.deleteMany({
      where: { OR: [{ userAId: { in: USER_IDS } }, { userBId: { in: USER_IDS } }] },
    });

    // 5. Report
    const reports = await tx.report.deleteMany({
      where: { reporterId: { in: USER_IDS } },
    });

    // 6. Block
    const blocks = await tx.block.deleteMany({
      where: { OR: [{ blockerId: { in: USER_IDS } }, { blockedId: { in: USER_IDS } }] },
    });

    // 7. Like
    const likes = await tx.like.deleteMany({
      where: { userId: { in: USER_IDS } },
    });

    // 8. Comment
    const comments = await tx.comment.deleteMany({
      where: { userId: { in: USER_IDS } },
    });

    // 9. DiscoverPost (cascades its own Comments + Likes in the DB)
    const posts = await tx.discoverPost.deleteMany({
      where: { userId: { in: USER_IDS } },
    });

    // 10. User (Profile and UserInterest cascade automatically)
    const users = await tx.user.deleteMany({
      where: { id: { in: USER_IDS } },
    });

    return { ratings, messages, convs, sessions, reports, blocks, likes, comments, posts, users };
  });

  console.log('Deleted:');
  console.log('─'.repeat(36));
  console.log(`  ${'Rating'.padEnd(18)} ${result.ratings.count}`);
  console.log(`  ${'Message'.padEnd(18)} ${result.messages.count}`);
  console.log(`  ${'Conversation'.padEnd(18)} ${result.convs.count}`);
  console.log(`  ${'MatchSession'.padEnd(18)} ${result.sessions.count}`);
  console.log(`  ${'Report'.padEnd(18)} ${result.reports.count}`);
  console.log(`  ${'Block'.padEnd(18)} ${result.blocks.count}`);
  console.log(`  ${'Like'.padEnd(18)} ${result.likes.count}`);
  console.log(`  ${'Comment'.padEnd(18)} ${result.comments.count}`);
  console.log(`  ${'DiscoverPost'.padEnd(18)} ${result.posts.count}`);
  console.log(`  ${'User'.padEnd(18)} ${result.users.count}`);
  console.log('─'.repeat(36));
  const total =
    result.ratings.count +
    result.messages.count +
    result.convs.count +
    result.sessions.count +
    result.reports.count +
    result.blocks.count +
    result.likes.count +
    result.comments.count +
    result.posts.count +
    result.users.count;
  console.log(`  ${'TOTAL'.padEnd(18)} ${total}`);
  console.log('\nDone. Transaction committed.\n');
}

// ─── Entry point ──────────────────────────────────────────────────────────────

async function main() {
  if (DRY_RUN) {
    await dryRun();
  } else {
    await liveDelete();
  }
}

main()
  .catch((e) => {
    console.error('Error:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
