/**
 * Imports community prompts from data/community-prompts.json into the database.
 * Run AFTER fetch-prompts.mjs has downloaded the data.
 *
 * Usage: node scripts/seed-prompts.mjs [--dry-run] [--skip-existing]
 *
 * Options:
 *   --dry-run       Parse and validate without writing to DB
 *   --skip-existing Skip prompts that already exist (default: true)
 *   --limit N       Only import first N prompts (for testing)
 */

import { PrismaClient } from "@prisma/client";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const LIMIT = (() => {
  const i = args.indexOf("--limit");
  return i !== -1 ? parseInt(args[i + 1], 10) : null;
})();

const db = DRY_RUN ? null : new PrismaClient();

async function main() {
  const dataPath = path.join(ROOT, "data", "community-prompts.json");
  console.log(`Reading ${dataPath}...`);
  const raw = await fs.readFile(dataPath, "utf-8");
  const data = JSON.parse(raw);

  console.log(`Source: ${data.source}`);
  console.log(`Fetched at: ${data.fetchedAt}`);
  console.log(`Total prompts: ${data.total}`);
  console.log(`Categories: ${data.categories.length}`);
  if (DRY_RUN) console.log("DRY RUN — no DB writes.");

  const prompts = LIMIT ? data.prompts.slice(0, LIMIT) : data.prompts;
  if (LIMIT) console.log(`Importing first ${LIMIT} prompts only.`);

  // --- Step 1: Upsert categories ---
  console.log("\nUpserting categories...");
  const categoryIdMap = new Map(); // original ID → local DB ID

  for (const cat of data.categories) {
    if (DRY_RUN) {
      categoryIdMap.set(cat.id, cat.id);
      continue;
    }
    const slug = cat.slug || cat.name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
    const local = await db.category.upsert({
      where: { slug },
      update: { name: cat.name, icon: cat.icon || "" },
      create: {
        name: cat.name,
        slug,
        description: cat.description || "",
        icon: cat.icon || "",
      },
    });
    categoryIdMap.set(cat.id, local.id);
  }
  console.log(`  ${data.categories.length} categories ready.`);

  // --- Step 2: Find or create system user for unattributed prompts ---
  let systemUserId = null;
  if (!DRY_RUN) {
    const systemUser = await db.user.findFirst({ where: { role: "ADMIN" } });
    if (!systemUser) throw new Error("No ADMIN user found. Create one first.");
    systemUserId = systemUser.id;
  }

  // --- Step 3: Import prompts ---
  console.log(`\nImporting ${prompts.length} prompts...`);
  let imported = 0;
  let skipped = 0;
  let failed = 0;
  const errors = [];

  const contributorCache = new Map();

  async function getOrCreateContributor(username) {
    if (!username) return systemUserId;
    const key = username.toLowerCase().trim();
    if (contributorCache.has(key)) return contributorCache.get(key);

    const pseudoEmail = `${key}@unclaimed.tucprompt`;
    let user = await db.user.findFirst({
      where: { OR: [{ username: key }, { email: pseudoEmail }] },
    });

    if (!user) {
      user = await db.user.create({
        data: { username: key, email: pseudoEmail, name: username, role: "USER" },
      });
    }
    contributorCache.set(key, user.id);
    return user.id;
  }

  for (let i = 0; i < prompts.length; i++) {
    const p = prompts[i];
    process.stdout.write(`\r  ${i + 1}/${prompts.length} (imported: ${imported}, skipped: ${skipped}, failed: ${failed})`);

    if (!p.content?.trim()) {
      skipped++;
      continue;
    }

    if (DRY_RUN) {
      imported++;
      continue;
    }

    try {
      // Skip if already exists by title
      const existing = await db.prompt.findFirst({ where: { title: p.title } });
      if (existing) {
        skipped++;
        continue;
      }

      // Resolve author
      const authorUsername = p.author?.identifier || p.author?.username;
      const authorId = authorUsername
        ? await getOrCreateContributor(authorUsername)
        : systemUserId;

      // Resolve category
      const categoryId = p.category?.id
        ? categoryIdMap.get(p.category.id) || null
        : null;

      // Map type
      const typeMap = { TEXT: "TEXT", IMAGE: "IMAGE", VIDEO: "VIDEO", AUDIO: "AUDIO", STRUCTURED: "STRUCTURED" };
      const type = typeMap[p.type] || "TEXT";
      const structuredFormat = p.structuredFormat || null;

      // Create prompt
      const prompt = await db.prompt.create({
        data: {
          title: p.title,
          slug: p.slug || undefined,
          description: p.description || null,
          content: p.content,
          type,
          structuredFormat,
          isPrivate: false,
          authorId,
          categoryId,
        },
      });

      // Create initial version
      await db.promptVersion.create({
        data: {
          promptId: prompt.id,
          version: 1,
          content: p.content,
          changeNote: `Imported from prompts.chat (original id: ${p.id})`,
          createdBy: authorId,
        },
      });

      // Add tags if any
      if (p.tags?.length > 0) {
        for (const tagObj of p.tags) {
          const tagName = tagObj.tag?.name || tagObj.name;
          if (!tagName) continue;
          const slug = tagName.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
          const tag = await db.tag.upsert({
            where: { slug },
            update: {},
            create: { name: tagName, slug },
          });
          await db.promptTag.create({
            data: { promptId: prompt.id, tagId: tag.id },
          }).catch(() => {}); // ignore duplicate
        }
      }

      imported++;
    } catch (err) {
      failed++;
      errors.push(`"${p.title}": ${err.message}`);
    }
  }

  console.log(`\n\nResults:`);
  console.log(`  Imported: ${imported}`);
  console.log(`  Skipped:  ${skipped}`);
  console.log(`  Failed:   ${failed}`);
  if (errors.length > 0) {
    console.log(`\nFirst 10 errors:`);
    errors.slice(0, 10).forEach((e) => console.log(`  ✗ ${e}`));
  }

  if (!DRY_RUN) await db.$disconnect();
}

main().catch((err) => {
  console.error(err);
  if (db) db.$disconnect();
  process.exit(1);
});
