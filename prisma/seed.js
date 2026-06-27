"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const client_1 = require("@prisma/client");
const adapter_pg_1 = require("@prisma/adapter-pg");
require("dotenv/config");
const adapter = new adapter_pg_1.PrismaPg({ connectionString: process.env['DATABASE_URL'] });
const prisma = new client_1.PrismaClient({ adapter });
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
//# sourceMappingURL=seed.js.map