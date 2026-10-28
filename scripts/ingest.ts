import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { ingestDocument } from "../lib/ingestion";

// Load .env.local for CLI use (tsx doesn't load it automatically).
try {
  process.loadEnvFile(".env.local");
} catch {
  // .env.local is optional; missing keys surface clear errors later.
}

const SUPPORTED_EXT = new Set(["pdf", "txt", "md", "markdown"]);

function isSupportedFile(path: string): boolean {
  return SUPPORTED_EXT.has(join(path).split(".").pop()?.toLowerCase() ?? "");
}

function collectFiles(paths: string[]): string[] {
  const files: string[] = [];
  for (const p of paths) {
    const st = statSync(p);
    if (st.isFile()) {
      if (isSupportedFile(p)) files.push(p);
      else console.warn(`  skip unsupported file: ${p}`);
    } else if (st.isDirectory()) {
      for (const entry of readdirSync(p)) {
        const full = join(p, entry);
        if (statSync(full).isDirectory()) files.push(...collectFiles([full]));
        else if (isSupportedFile(full)) files.push(full);
      }
    }
  }
  return files;
}

function usage(): void {
  console.log(
    [
      "Usage: npm run ingest -- <files...|dirs...> [--dry-run]",
      "",
      "Ingests PDF/TXT/MD files into the knowledge base (extract -> clean -> chunk -> embed -> store).",
      "",
      "Options:",
      "  --dry-run   run the pipeline without writing to the database",
      "  -h, --help  show this help",
    ].join("\n"),
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("-h") || args.includes("--help")) {
    usage();
    return;
  }

  const dryRun = args.includes("--dry-run");
  const targets = args.filter((a) => a !== "--dry-run");

  if (targets.length === 0) {
    usage();
    process.exitCode = 1;
    return;
  }

  const files = collectFiles(targets);
  if (files.length === 0) {
    console.log("No supported files found (PDF, TXT, MD).");
    return;
  }

  if (!dryRun && !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error(
      "SUPABASE_SERVICE_ROLE_KEY is not set. Add it to .env.local, or use --dry-run.",
    );
    process.exitCode = 1;
    return;
  }

  let ready = 0;
  let failed = 0;
  let duplicates = 0;

  console.log(dryRun ? "DRY RUN — nothing will be written to the database.\n" : "");

  for (const file of files) {
    const buffer = readFileSync(file);
    const result = await ingestDocument({ name: join(file).split(/[/\\]/).pop() ?? file, buffer }, { dryRun });

    if (result.status === "ready") {
      ready += 1;
      console.log(
        `  OK   ${file}  -> ${result.chunkCount} chunks` +
          (result.dimensions ? ` (${result.dimensions}-dim, ${result.model})` : "") +
          (result.documentId ? ` [${result.documentId}]` : ""),
      );
    } else if (result.status === "duplicate") {
      duplicates += 1;
      console.log(`  DUP  ${file}  already indexed [${result.documentId}]`);
    } else {
      failed += 1;
      console.log(`  FAIL ${file}  -> ${result.error}`);
    }
  }

  console.log(
    `\nSummary: ${ready} ready, ${duplicates} duplicate, ${failed} failed (${files.length} file(s)).`,
  );
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});