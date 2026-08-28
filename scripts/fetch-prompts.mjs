/**
 * Fetches all prompts from prompts.chat (original platform) with full content.
 * Saves two files:
 *   - data/community-prompts.json  (2100+ community prompts with categories)
 *   - prompts.csv                  (classic curated prompts, placed at project root for existing import route)
 *
 * Usage: node scripts/fetch-prompts.mjs
 */

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const BASE_URL = "https://prompts.chat";
const CONCURRENCY = 5; // max parallel requests
const DELAY_MS = 100;  // ms between batches

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function fetchAllPages() {
  console.log("Fetching page 1 to discover total...");
  const first = await fetchJSON(`${BASE_URL}/api/prompts?limit=50&page=1`);
  const totalPages = first.totalPages;
  const total = first.total;
  console.log(`Total prompts: ${total} | Pages: ${totalPages}`);

  const allStubs = [...first.prompts];

  for (let page = 2; page <= totalPages; page++) {
    process.stdout.write(`\rFetching page ${page}/${totalPages}...`);
    const data = await fetchJSON(`${BASE_URL}/api/prompts?limit=50&page=${page}`);
    allStubs.push(...data.prompts);
    await sleep(DELAY_MS);
  }
  console.log(`\nCollected ${allStubs.length} prompt stubs.`);
  return allStubs;
}

async function fetchFullContent(stubs) {
  const results = [];
  let done = 0;

  for (let i = 0; i < stubs.length; i += CONCURRENCY) {
    const batch = stubs.slice(i, i + CONCURRENCY);
    const settled = await Promise.allSettled(
      batch.map((stub) =>
        fetchJSON(`${BASE_URL}/api/prompts/${stub.id}`).then((full) => ({
          ...full,
          // Ensure we have the category from the stub if not in full response
          category: full.category || stub.category,
          tags: full.tags || stub.tags || [],
          contributors: full.contributors || stub.contributors || [],
        }))
      )
    );

    for (const result of settled) {
      done++;
      if (result.status === "fulfilled") {
        results.push(result.value);
      } else {
        // Keep stub if full fetch failed
        const stub = batch[settled.indexOf(result)];
        console.warn(`\nFailed to fetch ${stub.id}: ${result.reason?.message}`);
        results.push({ ...stub, content: stub.contentPreview || "" });
      }
    }

    process.stdout.write(`\rFetched full content: ${done}/${stubs.length}`);
    await sleep(DELAY_MS);
  }
  console.log(`\nDone. ${results.length} prompts with full content.`);
  return results;
}

async function extractCategories(prompts) {
  const map = new Map();
  for (const p of prompts) {
    if (p.category?.id) {
      map.set(p.category.id, p.category);
    }
  }
  return [...map.values()];
}

async function fetchCSV() {
  console.log("Fetching classic CSV from prompts.chat...");
  const res = await fetch(`${BASE_URL}/prompts.csv`);
  if (!res.ok) throw new Error(`CSV fetch failed: HTTP ${res.status}`);
  return res.text();
}

async function main() {
  // --- Community prompts ---
  console.log("\n=== Fetching community prompts ===");
  const stubs = await fetchAllPages();
  const prompts = await fetchFullContent(stubs);
  const categories = await extractCategories(prompts);

  const output = {
    fetchedAt: new Date().toISOString(),
    source: BASE_URL,
    total: prompts.length,
    categories,
    prompts,
  };

  const outPath = path.join(ROOT, "data", "community-prompts.json");
  await fs.writeFile(outPath, JSON.stringify(output, null, 2), "utf-8");
  console.log(`Saved: ${outPath} (${(JSON.stringify(output).length / 1024).toFixed(0)} KB)`);

  // --- Classic CSV ---
  console.log("\n=== Fetching classic CSV prompts ===");
  const csv = await fetchCSV();
  const csvPath = path.join(ROOT, "prompts.csv");
  await fs.writeFile(csvPath, csv, "utf-8");
  const lines = csv.split("\n").filter((l) => l.trim()).length - 1; // subtract header
  console.log(`Saved: ${csvPath} (~${lines} prompts)`);

  console.log("\nDone! Next steps:");
  console.log("  1. Classic CSV: call POST /api/admin/import-prompts (already built)");
  console.log("  2. Community JSON: run node scripts/seed-prompts.mjs");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
