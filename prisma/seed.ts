import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import 'dotenv/config';

const adapter = new PrismaPg({ connectionString: process.env['DATABASE_URL']! });
const prisma = new PrismaClient({ adapter });

const INTERESTS = [
  'Music',
  'Travel',
  'Fitness',
  'Movies',
  'Gaming',
  'Reading',
  'Cooking',
  'Art',
  'Photography',
  'Hiking',
  'Dancing',
  'Sports',
  'Technology',
  'Fashion',
  'Yoga',
  'Coffee',
  'Nature',
  'Pets',
  'Volunteering',
  'Languages',
];

async function main() {
  console.log('Seeding interests...');
  for (const name of INTERESTS) {
    await prisma.interest.upsert({
      where: { name },
      update: {},
      create: { name },
    });
  }
  console.log(`Seeded ${INTERESTS.length} interests.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
